import fs from 'fs/promises';
import path from 'path';
import { analyzeAndFormatFilename, analyzeAuxiliaryFileRole, getCanonicalTitleMapping } from './nameParser.js';
import { MediaBlueprint, EpisodeOrMovie, MediaFile, MediaSeries } from './types.js';
import { StatsCollector } from './stats.js'; // 导入统计收集器

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts', '.rmvb']);
const SAME_NAME_EXTENSIONS = new Set(['.nfo', '.ass', '.ssa', '.srt', '.sub', '.sup', '.vtt', '.lrc']);

// 修改：增加 stats 参数
async function scanDirectory(dir: string, blueprint: MediaBlueprint, concurrency: number, stats: StatsCollector): Promise<void> {
  console.log(`[扫描] 进入目录: ${dir}`);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[错误] 无法读取目录 ${dir}:`, err);
    return;
  }

  const fileGroups = new Map<string, MediaFile[]>();
  for (const entry of entries) {
    if (entry.isFile()) {
      const baseName = path.parse(entry.name).name;
      if (!fileGroups.has(baseName)) {
        fileGroups.set(baseName, []);
      }
      fileGroups.get(baseName)!.push({
        sourcePath: path.join(dir, entry.name),
        originalFilename: entry.name,
      });
    }
  }

  const videoTasks = Array.from(fileGroups.values()).map(files => {
    const videoFile = files.find(f => VIDEO_EXTENSIONS.has(path.extname(f.originalFilename).toLowerCase()));
    if (!videoFile) return null;
    return {
      videoFile,
      sidecarFiles: files.filter(f => f.sourcePath !== videoFile.sourcePath),
    };
  }).filter(task => task !== null) as { videoFile: MediaFile; sidecarFiles: MediaFile[] }[];

  if (videoTasks.length > 0) {
    console.log(`[信息] 在 ${dir} 中发现 ${videoTasks.length} 个视频文件组需要分析。`);
  }

  for (let i = 0; i < videoTasks.length; i += concurrency) {
    const chunk = videoTasks.slice(i, i + concurrency);
    console.log(`[并行分析] 正在处理 ${chunk.length} 个文件... (进度: ${i + chunk.length}/${videoTasks.length})`);

    const promises = chunk.map(async ({ videoFile, sidecarFiles }) => {
      const parentDir = path.basename(path.dirname(videoFile.sourcePath));
      // 传递 stats
      const analysisResult = await analyzeAndFormatFilename(videoFile.originalFilename, parentDir, stats);

      if (!analysisResult.aiInfo || !analysisResult.newFilename) return null;

      const sidecarPromises = sidecarFiles.map(async (file) => {
        // 传递 stats
        const role = await analyzeAuxiliaryFileRole(analysisResult.newFilename!, file.originalFilename, stats);
        file.role = role;
        return file;
      });

      const processedSidecars = await Promise.all(sidecarPromises);

      return {
        season: analysisResult.aiInfo.season,
        episode: analysisResult.aiInfo.episode,
        videoFile: videoFile,
        sidecarFiles: processedSidecars,
        aiInfo: analysisResult.aiInfo,
      } as EpisodeOrMovie;
    });

    const chunkResults = await Promise.allSettled(promises);

    chunkResults.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        addToBlueprint(blueprint, result.value);
      } else if (result.status === 'rejected') {
        console.error('[错误] 一个并行分析任务失败:', result.reason);
      }
    });
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // 传递 stats
      await scanDirectory(path.join(dir, entry.name), blueprint, concurrency, stats);
    }
  }
}

function addToBlueprint(blueprint: MediaBlueprint, item: EpisodeOrMovie): void {
  if (item.aiInfo.type === 'unknown') return;
  const title = item.aiInfo.title;
  if (!blueprint[title]) {
    blueprint[title] = {
      titleVotes: {},
      yearVotes: {},
      items: [],
      type: item.aiInfo.type,
    };
  }
  const series = blueprint[title];
  series.items.push(item);
  series.titleVotes[title] = (series.titleVotes[title] || 0) + 1;
  if (item.aiInfo.year != null) {
    series.yearVotes[String(item.aiInfo.year)] = (series.yearVotes[String(item.aiInfo.year)] || 0) + 1;
  }
}

// 修改：增加 stats 参数
async function consolidateBlueprint(rawBlueprint: MediaBlueprint, stats: StatsCollector): Promise<MediaBlueprint> {
  const titles = Object.keys(rawBlueprint);
  if (titles.length === 0) return {};

  // 传递 stats
  const canonicalTitleMap = await getCanonicalTitleMapping(titles, stats);
  if (!canonicalTitleMap) {
    console.error('[错误] 无法从 AI 获取标题映射，将跳过整理步骤。');
    return rawBlueprint;
  }
  const finalBlueprint: MediaBlueprint = {};
  for (const originalTitle in canonicalTitleMap) {
    const canonicalTitle = canonicalTitleMap[originalTitle];
    const seriesToMerge = rawBlueprint[originalTitle];
    if (!seriesToMerge) continue;
    if (!finalBlueprint[canonicalTitle]) {
      finalBlueprint[canonicalTitle] = {
        canonicalTitle: canonicalTitle,
        items: [],
        titleVotes: {},
        yearVotes: {},
        type: seriesToMerge.type,
      };
    }
    const targetSeries = finalBlueprint[canonicalTitle];
    targetSeries.items.push(...seriesToMerge.items);
    Object.assign(targetSeries.titleVotes, seriesToMerge.titleVotes);
    Object.assign(targetSeries.yearVotes, seriesToMerge.yearVotes);
  }
  for (const series of Object.values(finalBlueprint)) {
    const yearVotes = series.yearVotes;
    if (Object.keys(yearVotes).length > 0) {
      const finalYear = Object.entries(yearVotes).reduce((a, b) => a[1] > b[1] ? a : b)[0];
      series.canonicalYear = parseInt(finalYear, 10);
    }
  }
  return finalBlueprint;
}


async function createLink(source: string, destination: string, linkType: string, pathMode: string): Promise<void> {
  let linkSource = source;
  if (linkType === 'soft' && pathMode === 'relative') {
    linkSource = path.relative(path.dirname(destination), source);
  }
  try {
    if (linkType === 'soft') {
      await fs.symlink(linkSource, destination);
    } else {
      await fs.link(source, destination);
    }
  } catch (error: any) {
    if (error.code !== 'EEXIST') {
      console.error(`[错误] 创建 ${linkType} 链接失败 for ${source}:`, error);
    }
  }
}


async function generateLinks(blueprint: MediaBlueprint, targetRootDir: string, linkType: string, pathMode: string): Promise<void> {
  for (const series of Object.values(blueprint)) {
    if (!series.canonicalTitle) continue;
    const cleanTitle = series.canonicalTitle.replace(/[<>:"/\\|?*]/g, '').trim();
    let seriesDirName = cleanTitle;
    if (series.type === 'movie' && series.canonicalYear) {
      seriesDirName = `${cleanTitle} (${series.canonicalYear})`;
    }
    const seriesPath = path.join(targetRootDir, seriesDirName);
    await fs.mkdir(seriesPath, { recursive: true });
    for (const item of series.items) {
      let targetPath = seriesPath;
      let newBaseFilename: string;
      if (series.type === 'show') {
        if (item.season == null || item.episode == null) continue;
        const seasonStr = String(item.season).padStart(2, '0');
        const episodeStr = String(item.episode).padStart(2, '0');
        const seasonDir = `Season ${seasonStr}`;
        targetPath = path.join(seriesPath, seasonDir);
        newBaseFilename = `${cleanTitle} - S${seasonStr}E${episodeStr}`;
      } else {
        newBaseFilename = seriesDirName;
      }
      await fs.mkdir(targetPath, { recursive: true });
      const videoExt = path.extname(item.videoFile.originalFilename);
      await createLink(item.videoFile.sourcePath, path.join(targetPath, `${newBaseFilename}${videoExt}`), linkType, pathMode);
      for (const file of item.sidecarFiles) {
        const sidecarExt = path.extname(file.originalFilename).toLowerCase();
        let finalSidecarName: string;
        if (SAME_NAME_EXTENSIONS.has(sidecarExt)) {
          finalSidecarName = `${newBaseFilename}${sidecarExt}`;
        } else {
          const roleSuffix = file.role ? `-${file.role}` : '';
          finalSidecarName = `${newBaseFilename}${roleSuffix}${sidecarExt}`;
        }
        await createLink(file.sourcePath, path.join(targetPath, finalSidecarName), linkType, pathMode);
      }
    }
    console.log(`[成功] 已为 "${series.canonicalTitle}" 创建整理好的链接。`);
  }
}

// 修改：增加 stats 参数
export async function organizeMediaLibrary(sourceDirs: string[], targetDir: string, isDebugMode: boolean, concurrency: number, linkType: string, pathMode: string, stats: StatsCollector): Promise<void> {
  console.log('--- 阶段 1: 开始扫描和分析文件... ---');
  const rawBlueprint: MediaBlueprint = {};
  for (const sourceDir of sourceDirs) {
    // 传递 stats
    await scanDirectory(sourceDir, rawBlueprint, concurrency, stats);
  }
  console.log('--- 阶段 1: 完成 ---');

  console.log('\n--- 阶段 2: 开始进行 AI 宏观整理... ---');
  // 传递 stats
  const finalBlueprint = await consolidateBlueprint(rawBlueprint, stats);
  console.log('--- 阶段 2: 完成 ---');

  if (isDebugMode) {
    const debugFilePath = path.join(process.cwd(), 'debug_log_organized.json');
    console.log(`\n--- 调试模式: 将把最终的整理计划写入当前执行目录: ${debugFilePath} ---`);
    try {
      await fs.writeFile(debugFilePath, JSON.stringify(finalBlueprint, null, 2));
    } catch (error) {
      console.error(`错误: 无法写入调试日志文件到 ${debugFilePath}`, error);
    }
  } else {
    console.log('\n--- 阶段 3: 开始创建链接... ---');
    await generateLinks(finalBlueprint, targetDir, linkType, pathMode);
    console.log('--- 阶段 3: 完成 ---');
  }
}
