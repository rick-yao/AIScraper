import path from 'path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';

//++++++++++ 新增：全局异常捕获 ++++++++++
// 捕获未处理的Promise拒绝，以提供更清晰的错误日志，防止程序在没有明确原因的情况下崩溃。
// 这对于调试由依赖库内部引起的隐藏错误尤其有用。
process.on('unhandledRejection', (reason, promise) => {
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.error('!!!     未处理的PROMISE拒绝     !!!');
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.error('原因:', reason);
});
//++++++++++++++++++++++++++++++++++++++++

// !!!! 重要 !!!!
// 已将环境变量名更新为 AI_SCRAPER_API_KEY
const API_KEY = process.env.AI_SCRAPER_API_KEY;

/**
 * 使用 Zod 定义 AI 返回的媒体信息结构，确保类型安全
 */
const mediaInfoSchema = z.object({
  title: z.string().describe("电影或电视剧的主要标题。"),
  season: z.number().nullable().optional().describe("电视剧的季数。"),
  episode: z.number().nullable().optional().describe("电视剧的集数。"),
  type: z.enum(["show", "movie", "unknown"]).describe("文件是电视剧集还是电影。"),
  year: z.number().nullable().optional().describe("电影的上映年份。"),
});

// 从 Zod schema 推断出 TypeScript 类型
type MediaInfo = z.infer<typeof mediaInfoSchema>;

/**
 * AI分析结果的返回结构
 */
export type AnalysisResult = {
  newFilename: string | null;
  aiInfo: MediaInfo | null;
}

/**
 * 构建发送给AI的提示 (此函数保持不变)
 */
function buildPrompt(filename: string, parentDir: string): string {
  return `你是一个为Plex和Jellyfin服务的媒体文件整理专家。你的任务是分析视频文件名及其父目录，以提取结构化信息。

  请分析以下文件。
  - 文件名: "${filename}"
  - 父目录: "${parentDir}"

  请严格遵守以下规则:
  1. 判断文件是电视剧集还是电影。
  2. 对于电视剧，提取剧名、季号和集号。
  3. 对于电影，提取电影名和上映年份。
  4. 'title'应为电视剧或电影的干净名称。删除所有额外信息，如分辨率、发布组、音频格式等。例如，"The.Mandalorian.S03E05.1080p.WEB-DL"的标题应为"The Mandalorian"。
  5. 如果你无法确定信息，请将'type'设置为'unknown'，并将'title'设置为不带扩展名的原始文件名。

  返回一个与所提供Schema匹配的JSON对象。不要添加任何额外的文本或解释。`;
}

/**
 * 调用AI SDK获取媒体信息
 */
async function getMediaInfo(filename: string, parentDir: string): Promise<MediaInfo | null> {
  if (!API_KEY) {
    console.error('致命错误: 环境变量 AI_SCRAPER_API_KEY 未设置。脚本无法在没有它的情况下运行。');
    process.exit(1);
  }

  const google = createGoogleGenerativeAI({ apiKey: API_KEY });
  const prompt = buildPrompt(filename, parentDir);

  try {
    const { object } = await generateObject({
      model: google('models/gemini-2.5-flash-preview-05-20'),
      schema: mediaInfoSchema,
      prompt: prompt,
    });
    return object;
  } catch (error) {
    console.error('[错误] 调用AI SDK或解析响应时失败:', error);
    return null;
  }
}

/**
 * 根据AI的输出格式化新文件名
 */
function formatNewFilename(info: MediaInfo, originalExt: string): string | null {
  if (!info || !info.title || info.type === 'unknown') {
    return null;
  }
  const cleanTitle = info.title.replace(/[<>:"/\\|?*]/g, '').trim();
  if (info.type === 'show' && info.season != null && info.episode != null) {
    const seasonStr = String(info.season).padStart(2, '0');
    const episodeStr = String(info.episode).padStart(2, '0');
    return `${cleanTitle} - S${seasonStr}E${episodeStr}${originalExt}`;
  }
  if (info.type === 'movie') {
    return info.year ? `${cleanTitle} (${info.year})${originalExt}` : `${cleanTitle}${originalExt}`;
  }
  return null;
}

/**
 * 模块的主导出函数：分析文件名并返回格式化结果
 * @param originalFilename - 原始完整文件名
 * @param parentDir - 父目录名
 * @returns {Promise<AnalysisResult>} - 包含新文件名和AI信息的分析结果
 */
export async function analyzeAndFormatFilename(originalFilename: string, parentDir: string): Promise<AnalysisResult> {
  const filenameWithoutExt = path.parse(originalFilename).name;
  const extension = path.parse(originalFilename).ext;

  if (!extension) return { newFilename: null, aiInfo: null };

  const info = await getMediaInfo(filenameWithoutExt, parentDir);

  if (!info) {
    return { newFilename: null, aiInfo: null };
  }

  const newFilename = formatNewFilename(info, extension);
  return { newFilename, aiInfo: info };
}
