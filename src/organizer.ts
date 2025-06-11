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
 */
async function scanDirectory(dir: string, blueprint: MediaBlueprint): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  // 1. 将目录下的所有文件按文件名（不含扩展名）分组
  const fileGroups = new Map<string, MediaFile[]>();
  for (const entry of entries) {
    if (entry.isFile()) {
      // 处理像 '南方公园 - S01E01 - ...-thumb.jpg' 这样的特殊文件名
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

  // 2. 处理每个文件组
  for (const files of fileGroups.values()) {
    const videoFile = files.find(f => VIDEO_EXTENSIONS.has(path.extname(f.originalFilename).toLowerCase()));

    // 如果该组包含视频文件，则进行AI分析
    if (videoFile) {
      console.log(`[分析] ${videoFile.originalFilename}`);
      const parentDir = path.basename(path.dirname(videoFile.sourcePath));
      const { aiInfo } = await analyzeAndFormatFilename(videoFile.originalFilename, parentDir);

      if (aiInfo && aiInfo.type !== 'unknown') {
        const sidecarFiles = files.filter(f => f.sourcePath !== videoFile.sourcePath);
        const episode: EpisodeOrMovie = {
          season: aiInfo.season,
          episode: aiInfo.episode,
          videoFile: videoFile,
          sidecarFiles: sidecarFiles,
          aiInfo: aiInfo,
        };
        // 将分析结果添加到蓝图中
        addToBlueprint(blueprint, episode);
      }
    }
  }

  // 3. 递归处理子目录
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await scanDirectory(path.join(dir, entry.name), blueprint);
    }
  }
}

/**
 * 将单个剧集/电影信息添加到总蓝图中
 * @param blueprint - 总蓝图
 * @param item - 要添加的剧集/电影
 */
function addToBlueprint(blueprint: MediaBlueprint, item: EpisodeOrMovie): void {
  // FIX: 增加类型守卫，防止 'unknown' 类型污染数据，解决类型错误
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
      type: item.aiInfo.type, // 此处赋值现在是安全的
    };
  }

  const series = blueprint[title];
  series.items.push(item);
  series.titleVotes[title] = (series.titleVotes[title] || 0) + 1;
  // FIX: 确保年份存在再进行投票
  if (year != null) {
    series.yearVotes[String(year)] = (series.yearVotes[String(year)] || 0) + 1;
  }
}


// --- 阶段二: 数据整理与决策 (Consolidate & Decide) ---

/**
 * 整理蓝图，选出最终标题和年份
 * @param blueprint - 原始蓝图
 * @returns - 合并和整理后的新蓝图
 */
function consolidateBlueprint(blueprint: MediaBlueprint): MediaBlueprint {
  const consolidated = new Map<string, MediaSeries>();

  // 第一次遍历：按最可能的标题合并剧集（例如将 "瑞克和莫蒂" 合并到 "Rick and Morty"）
  for (const series of Object.values(blueprint)) {
    const representativeTitle = getMostVoted(series.titleVotes);
    // FIX: 检查 `getMostVoted` 的 `null` 返回值
    if (!representativeTitle) {
      continue; // 如果没有标题胜出，则跳过
    }

    const existingSeries = consolidated.get(representativeTitle);
    if (existingSeries) {
      // 合并到已有的系列中
      existingSeries.items.push(...series.items);
      Object.entries(series.titleVotes).forEach(([title, count]) => {
        existingSeries.titleVotes[title] = (existingSeries.titleVotes[title] || 0) + count;
      });
      Object.entries(series.yearVotes).forEach(([year, count]) => {
        existingSeries.yearVotes[year] = (existingSeries.yearVotes[year] || 0) + count;
      });
    } else {
      // FIX: 确保key是字符串，而不是 `string | null`
      consolidated.set(representativeTitle, series);
    }
  }

  // 第二次遍历：为每个合并后的系列确定最终的“官方”标题和年份
  consolidated.forEach(series => {
    const finalTitle = getMostVoted(series.titleVotes);
    const finalYear = getMostVoted(series.yearVotes);

    // FIX: 使用 `?? undefined` 将 null 转换为 undefined，以匹配 `canonicalTitle` 的类型
    series.canonicalTitle = finalTitle ?? undefined;
    // FIX: 检查年份是否存在再解析
    series.canonicalYear = finalYear ? parseInt(finalYear, 10) : null;
  });

  // 创建最终的蓝图对象，并使用官方标题作为键
  const finalBlueprint: MediaBlueprint = {};
  consolidated.forEach(series => {
    // FIX: 确保官方标题存在再添加到最终结果中
    if (series.canonicalTitle) {
      finalBlueprint[series.canonicalTitle] = series;
    }
  });

  return finalBlueprint;
}


/**
 * 从投票记录中找出得票最多的选项
 */
function getMostVoted(votes: Record<string, number>): string | null {
  if (Object.keys(votes).length === 0) return null;
  return Object.entries(votes).reduce((a, b) => a[1] > b[1] ? a : b)[0];
}


// --- 阶段三: 生成最终目录结构 (Generate & Link) ---

/**
 * 根据整理好的蓝图生成软链接
 * @param blueprint - 整理好的蓝图
 * @param targetRootDir - 目标根目录
 */
async function generateSymlinks(blueprint: MediaBlueprint, targetRootDir: string): Promise<void> {
  for (const series of Object.values(blueprint)) {
    // `!` 断言是安全的，因为我们在 `consolidateBlueprint` 的最后一步已过滤掉了没有 `canonicalTitle` 的系列
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
        if (item.season == null || item.episode == null) continue; // 跳过没有季/集信息的剧集文件
        const seasonStr = String(item.season).padStart(2, '0');
        const episodeStr = String(item.episode).padStart(2, '0');
        const seasonDir = `Season ${seasonStr}`;
        targetPath = path.join(seriesPath, seasonDir);
        newBaseFilename = `${cleanTitle} - S${seasonStr}E${episodeStr}`;
      } else { // Movie
        newBaseFilename = seriesDirName;
      }

      await fs.mkdir(targetPath, { recursive: true });

      // 链接主视频文件
      const videoExt = path.extname(item.videoFile.originalFilename);
      await createSymlink(item.videoFile.sourcePath, path.join(targetPath, `${newBaseFilename}${videoExt}`));

      // 链接所有辅助文件
      for (const file of item.sidecarFiles) {
        const sidecarExt = path.extname(file.originalFilename);
        // 处理 -thumb.jpg 后缀
        const specialSuffix = file.originalFilename.match(/-thumb\.jpg$/i) ? '-thumb' : '';
        await createSymlink(file.sourcePath, path.join(targetPath, `${newBaseFilename}${specialSuffix}${sidecarExt}`));
      }
    }
    console.log(`[成功] 已为 "${series.canonicalTitle}" 创建整理好的链接。`);
  }
}


/**
 * 创建软链接的辅助函数
 */
async function createSymlink(source: string, destination: string): Promise<void> {
  try {
    await fs.symlink(source, destination);
  } catch (error: any) {
    if (error.code === 'EEXIST') {
      // console.warn(`[警告] 目标文件已存在，跳过: ${destination}`);
    } else {
      console.error(`[错误] 创建链接失败 for ${source}:`, error);
    }
  }
}


// --- 主函数 ---

/**
 * 运行整理媒体库的完整流程
 * @param sourceDir - 源目录
 * @param targetDir - 目标目录
 * @param isDebugMode - 是否为调试模式
 */
export async function organizeMediaLibrary(sourceDir: string, targetDir: string, isDebugMode: boolean): Promise<void> {
  console.log('--- 阶段 1: 开始扫描和分析文件... ---');
  const rawBlueprint: MediaBlueprint = {};
  await scanDirectory(sourceDir, rawBlueprint);
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
