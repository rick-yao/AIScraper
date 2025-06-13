import fs from 'fs/promises';
import path from 'path';
import { analyzeAndFormatFilename, analyzeAuxiliaryFileRole, getCanonicalTitleMapping } from './nameParser.js';
import { MediaBlueprint, EpisodeOrMovie, MediaFile, MediaSeries } from './types.js';
import { StatsCollector } from './stats.js';

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts', '.rmvb']);
const SAME_NAME_EXTENSIONS = new Set(['.nfo', '.ass', '.ssa', '.srt', '.sub', '.sup', '.vtt', '.lrc']);

// ++++++++++ 核心升级：通过检查链接来建立状态模型 ++++++++++
/**
 * 扫描已整理的目标目录，构建一个已存在链接的状态集合。
 * @param targetDir - 要扫描的目标目录。
 * @param linkType - 链接类型 ('soft' 或 'hard')。
 * @returns 一个包含已存在剧集唯一标识（如 'Rick and Morty-S01E01'）的 Set。
 */
async function buildExistingState(targetDir: string, linkType: string): Promise<Set<string>> {
  const existingState = new Set<string>();
  console.log(`[状态扫描] 正在分析目标目录 (${linkType} 链接模式)...`);

  // 对于硬链接，我们无法仅从目标目录可靠地确定状态。
  // 我们将依赖创建链接时的错误捕获来实现幂等性。
  if (linkType === 'hard') {
    console.log('[状态扫描] 硬链接模式：跳过预扫描，将依赖创建时的错误捕获。');
    return existingState;
  }

  // 对于软链接，我们可以明确地检查符号链接。
  try {
    const seriesDirs = await fs.readdir(targetDir, { withFileTypes: true });
    for (const seriesDir of seriesDirs) {
      if (seriesDir.isDirectory()) {
        const seriesNameMatch = seriesDir.name.match(/^(.*?) \(\d{4}\)$/);
        const seriesName = seriesNameMatch ? seriesNameMatch[1] : seriesDir.name;

        const seriesPath = path.join(targetDir, seriesDir.name);
        const seasonDirs = await fs.readdir(seriesPath, { withFileTypes: true });

        for (const seasonDir of seasonDirs) {
          if (seasonDir.isDirectory() && seasonDir.name.toLowerCase().startsWith('season')) {
            const seasonPath = path.join(seriesPath, seasonDir.name);
            const episodeFiles = await fs.readdir(seasonPath, { withFileTypes: true });
            for (const episodeFile of episodeFiles) {
              const fullPath = path.join(seasonPath, episodeFile.name);
              // 使用 lstat 来检查链接本身，而不是它指向的文件
              const stats = await fs.lstat(fullPath);

              // 关键检查：确保它是一个符号链接
              if (stats.isSymbolicLink()) {
                const match = episodeFile.name.match(/S(\d{2,})E(\d{2,})/i);
                if (match) {
                  const seasonNum = parseInt(match[1], 10);
                  const episodeNum = parseInt(match[2], 10);
                  const uniqueId = `${seriesName}-S${seasonNum}E${episodeNum}`;
                  existingState.add(uniqueId);
                }
              }
            }
          }
        }
      }
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.warn('[警告] 扫描目标目录时出错，将假定目标目录为空:', error.message);
    }
  }

  console.log(`[状态扫描] 完成，在目标目录中找到 ${existingState.size} 个已整理的符号链接。`);
  return existingState;
}

// ++++++++++ 主函数：将 linkType 传递给状态构建函数 ++++++++++
export async function organizeMediaLibrary(sourceDirs: string[], targetDir: string, isDebugMode: boolean, concurrency: number, linkType: string, pathMode: string, stats: StatsCollector): Promise<void> {

  // 传递 linkType 给状态构建函数
  const existingState = isDebugMode ? new Set<string>() : await buildExistingState(targetDir, linkType);

  console.log('\n--- 阶段 1: 开始扫描和分析源文件... ---');
  const rawBlueprint: MediaBlueprint = {};
  for (const sourceDir of sourceDirs) {
    await scanDirectory(sourceDir, rawBlueprint, concurrency, stats);
  }
  console.log('--- 阶段 1: 完成 ---');

  console.log('\n--- 阶段 2: 开始进行 AI 宏观整理... ---');
  const finalBlueprint = await consolidateBlueprint(rawBlueprint, stats);
  console.log('--- 阶段 2: 完成 ---');

  if (isDebugMode) {
    const debugFilePath = path.join(process.cwd(), 'debug_log_organized.json');
    console.log(`\n--- 调试模式: 将把最终的整理计划写入当前执行目录: ${debugFilePath} ---`);
    await fs.writeFile(debugFilePath, JSON.stringify(finalBlueprint, null, 2));
  } else {
    console.log('\n--- 阶段 3: 开始同步文件... ---');
    await generateLinks(finalBlueprint, existingState, targetDir, linkType, pathMode);
    console.log('--- 阶段 3: 完成 ---');
  }
}


// ##################################################################
// # 以下是未发生重大逻辑变化的代码，为保持完整性而附上 #
// ##################################################################

async function generateLinks(blueprint: MediaBlueprint, existingState: Set<string>, targetRootDir: string, linkType: string, pathMode: string): Promise<void> {
  let newLinksCreated = 0;
  for (const series of Object.values(blueprint)) {
    if (!series.canonicalTitle) continue;
    const cleanTitle = series.canonicalTitle.replace(/[<>:"/\\|?*]/g, '').trim();
    let seriesDirName = cleanTitle;
    if (series.type === 'movie' && series.canonicalYear) {
      seriesDirName = `${cleanTitle} (${series.canonicalYear})`;
    }
    const seriesPath = path.join(targetRootDir, seriesDirName);

    for (const item of series.items) {
      let targetPath = seriesPath;
      let newBaseFilename: string;
      let uniqueId: string;

      if (series.type === 'show') {
        if (item.season == null || item.episode == null) continue;
        const seasonNum = item.season;
        const episodeNum = item.episode;
        const seasonStr = String(seasonNum).padStart(2, '0');
        const episodeStr = String(episodeNum).padStart(2, '0');

        uniqueId = `${cleanTitle}-S${seasonNum}E${episodeNum}`;

        if (existingState.has(uniqueId)) {
          continue;
        }

        const seasonDir = `Season ${seasonStr}`;
        targetPath = path.join(seriesPath, seasonDir);
        newBaseFilename = `${cleanTitle} S${seasonStr}E${episodeStr}`;
      } else {
        newBaseFilename = seriesDirName;
      }

      await fs.mkdir(targetPath, { recursive: true });

      const videoExt = path.extname(item.videoFile.originalFilename);
      await createLink(item.videoFile.sourcePath, path.join(targetPath, `${newBaseFilename}${videoExt}`), linkType, pathMode);
      newLinksCreated++;

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
  }
  if (newLinksCreated > 0) {
    console.log(`[成功] 已为 ${newLinksCreated} 个新文件创建了链接。`);
  } else {
    console.log('[信息] 无新文件需要处理，目标目录已是最新状态。');
  }
}

async function scanDirectory(dir: string, blueprint: MediaBlueprint, concurrency: number, stats: StatsCollector): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // console.error(`[错误] 无法读取目录 ${dir}:`, err);
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
    // console.log(`[信息] 在 ${dir} 中发现 ${videoTasks.length} 个视频文件组需要分析。`);
  }

  for (let i = 0; i < videoTasks.length; i += concurrency) {
    const chunk = videoTasks.slice(i, i + concurrency);

    const promises = chunk.map(async ({ videoFile, sidecarFiles }) => {
      const parentDir = path.basename(path.dirname(videoFile.sourcePath));
      const analysisResult = await analyzeAndFormatFilename(videoFile.originalFilename, parentDir, stats);

      if (!analysisResult.aiInfo || !analysisResult.newFilename) return null;

      const sidecarPromises = sidecarFiles.map(async (file) => {
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
        // console.error('[错误] 一个并行分析任务失败:', result.reason);
      }
    });
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
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

async function consolidateBlueprint(rawBlueprint: MediaBlueprint, stats: StatsCollector): Promise<MediaBlueprint> {
  const titles = Object.keys(rawBlueprint);
  if (titles.length === 0) return {};

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
