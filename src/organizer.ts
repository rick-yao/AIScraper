import fs from 'fs/promises';
import path from 'path';
import { analyzeAndFormatFilename } from './nameParser.js';
import { MediaBlueprint, EpisodeOrMovie, MediaFile, MediaSeries } from './types.js';

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts', '.rmvb']);

// --- 阶段一: 扫描与信息采集 (Scan & Gather) ---

/**
 * 递归扫描源目录，构建媒体库蓝图
 * @param dir - 当前要扫描的目录
 * @param blueprint - 要填充的媒体蓝图对象
 * @param concurrency - 并行处理数
 */
async function scanDirectory(dir: string, blueprint: MediaBlueprint, concurrency: number): Promise<void> {
  console.log(`[扫描] 进入目录: ${dir}`);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[错误] 无法读取目录 ${dir}:`, err);
    return; // 无法读取目录则跳过
  }

  // 1. 将目录下的所有文件按文件名（不含扩展名）分组
  const fileGroups = new Map<string, MediaFile[]>();
  for (const entry of entries) {
    if (entry.isFile()) {
      const baseName = path.parse(entry.name).name.replace(/-thumb$/, '');
      if (!fileGroups.has(baseName)) {
        fileGroups.set(baseName, []);
      }
      fileGroups.get(baseName)!.push({
        sourcePath: path.join(dir, entry.name),
        originalFilename: entry.name,
      });
    }
  }

  // 2. 为当前目录的所有视频文件创建分析任务
  const tasksInThisDir: { videoFile: MediaFile; sidecarFiles: MediaFile[] }[] = [];
  for (const files of fileGroups.values()) {
    const videoFile = files.find(f => VIDEO_EXTENSIONS.has(path.extname(f.originalFilename).toLowerCase()));
    if (videoFile) {
      tasksInThisDir.push({
        videoFile: videoFile,
        sidecarFiles: files.filter(f => f.sourcePath !== videoFile.sourcePath),
      });
    }
  }

  // 3. 并行处理这些任务
  console.log(`[信息] 在 ${dir} 中发现 ${tasksInThisDir.length} 个视频文件组需要分析。`);
  for (let i = 0; i < tasksInThisDir.length; i += concurrency) {
    const chunk = tasksInThisDir.slice(i, i + concurrency);
    console.log(`[并行分析] 正在处理 ${chunk.length} 个文件... (进度: ${i + chunk.length}/${tasksInThisDir.length})`);

    const promises = chunk.map(async ({ videoFile, sidecarFiles }) => {
      const parentDir = path.basename(path.dirname(videoFile.sourcePath));
      const { aiInfo } = await analyzeAndFormatFilename(videoFile.originalFilename, parentDir);
      if (aiInfo && aiInfo.type !== 'unknown') {
        return {
          season: aiInfo.season,
          episode: aiInfo.episode,
          videoFile,
          sidecarFiles,
          aiInfo,
        } as EpisodeOrMovie;
      }
      return null;
    });

    // 使用 allSettled 保证即使有单个任务失败，其他任务也能继续
    const chunkResults = await Promise.allSettled(promises);

    chunkResults.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        addToBlueprint(blueprint, result.value);
      } else if (result.status === 'rejected') {
        console.error('[错误] 一个并行分析任务失败:', result.reason);
      }
    });
  }

  // 4. 递归处理子目录
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await scanDirectory(path.join(dir, entry.name), blueprint, concurrency);
    }
  }
}


/**
 * 将单个剧集/电影信息添加到总蓝图中 (此函数及以下函数均保持不变)
 */
function addToBlueprint(blueprint: MediaBlueprint, item: EpisodeOrMovie): void {
  if (item.aiInfo.type === 'unknown') {
    return;
  }
  const title = item.aiInfo.title;
  const year = item.aiInfo.year;
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
  if (year != null) {
    series.yearVotes[String(year)] = (series.yearVotes[String(year)] || 0) + 1;
  }
}

function getMostVoted(votes: Record<string, number>): string | null {
  if (Object.keys(votes).length === 0) return null;
  return Object.entries(votes).reduce((a, b) => a[1] > b[1] ? a : b)[0];
}

function consolidateBlueprint(blueprint: MediaBlueprint): MediaBlueprint {
  const consolidated = new Map<string, MediaSeries>();
  for (const series of Object.values(blueprint)) {
    const representativeTitle = getMostVoted(series.titleVotes);
    if (!representativeTitle) continue;
    const existingSeries = consolidated.get(representativeTitle);
    if (existingSeries) {
      existingSeries.items.push(...series.items);
      Object.entries(series.titleVotes).forEach(([title, count]) => {
        existingSeries.titleVotes[title] = (existingSeries.titleVotes[title] || 0) + count;
      });
      Object.entries(series.yearVotes).forEach(([year, count]) => {
        existingSeries.yearVotes[year] = (existingSeries.yearVotes[year] || 0) + count;
      });
    } else {
      consolidated.set(representativeTitle, series);
    }
  }
  consolidated.forEach(series => {
    const finalTitle = getMostVoted(series.titleVotes);
    const finalYear = getMostVoted(series.yearVotes);
    series.canonicalTitle = finalTitle ?? undefined;
    series.canonicalYear = finalYear ? parseInt(finalYear, 10) : null;
  });
  const finalBlueprint: MediaBlueprint = {};
  consolidated.forEach(series => {
    if (series.canonicalTitle) {
      finalBlueprint[series.canonicalTitle] = series;
    }
  });
  return finalBlueprint;
}

async function generateSymlinks(blueprint: MediaBlueprint, targetRootDir: string): Promise<void> {
  for (const series of Object.values(blueprint)) {
    const cleanTitle = series.canonicalTitle!.replace(/[<>:"/\\|?*]/g, '').trim();
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
      await createSymlink(item.videoFile.sourcePath, path.join(targetPath, `${newBaseFilename}${videoExt}`));
      for (const file of item.sidecarFiles) {
        const sidecarExt = path.extname(file.originalFilename);
        const specialSuffix = file.originalFilename.match(/-thumb\.jpg$/i) ? '-thumb' : '';
        await createSymlink(file.sourcePath, path.join(targetPath, `${newBaseFilename}${specialSuffix}${sidecarExt}`));
      }
    }
    console.log(`[成功] 已为 "${series.canonicalTitle}" 创建整理好的链接。`);
  }
}

async function createSymlink(source: string, destination: string): Promise<void> {
  try {
    await fs.symlink(source, destination);
  } catch (error: any) {
    if (error.code === 'EEXIST') { }
    else {
      console.error(`[错误] 创建链接失败 for ${source}:`, error);
    }
  }
}

/**
 * 运行整理媒体库的完整流程
 */
export async function organizeMediaLibrary(sourceDir: string, targetDir: string, isDebugMode: boolean, concurrency: number): Promise<void> {
  console.log('--- 阶段 1: 开始扫描和分析文件... ---');
  const rawBlueprint: MediaBlueprint = {};
  await scanDirectory(sourceDir, rawBlueprint, concurrency);
  console.log('--- 阶段 1: 完成 ---');

  console.log('\n--- 阶段 2: 开始整理和合并媒体系列... ---');
  const consolidatedBlueprint = consolidateBlueprint(rawBlueprint);
  console.log('--- 阶段 2: 完成 ---');

  if (isDebugMode) {
    const debugFilePath = path.join(targetDir, 'debug_log_organized.json');
    console.log(`\n--- 调试模式: 将把最终的整理计划写入 ${debugFilePath} ---`);
    await fs.writeFile(debugFilePath, JSON.stringify(consolidatedBlueprint, null, 2));
  } else {
    console.log('\n--- 阶段 3: 开始创建软链接... ---');
    await generateSymlinks(consolidatedBlueprint, targetDir);
    console.log('--- 阶段 3: 完成 ---');
  }
}
