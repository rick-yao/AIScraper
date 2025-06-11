import path from 'path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';

process.on('unhandledRejection', (reason, promise) => {
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.error('!!!     未处理的PROMISE拒绝     !!!');
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.error('原因:', reason);
});

const API_KEY = process.env.AI_SCRAPER_API_KEY;
const google = createGoogleGenerativeAI({ apiKey: API_KEY });

// --- 视频文件分析 ---

const mediaInfoSchema = z.object({
  title: z.string().describe("电影或电视剧的主要标题。"),
  season: z.number().nullable().optional().describe("电视剧的季数。"),
  episode: z.number().nullable().optional().describe("电视剧的集数。"),
  type: z.enum(["show", "movie", "unknown"]).describe("文件是电视剧集还是电影。"),
  year: z.number().nullable().optional().describe("电影的上映年份。"),
});

type MediaInfo = z.infer<typeof mediaInfoSchema>;

export type AnalysisResult = {
  newFilename: string | null;
  aiInfo: MediaInfo | null;
}

function buildVideoPrompt(filename: string, parentDir: string): string {
  return `你是一个为Plex和Jellyfin服务的媒体文件整理专家。你的任务是分析视频文件名及其父目录，以提取结构化信息。请分析以下文件：\n- 文件名: "${filename}"\n- 父目录: "${parentDir}"\n请严格遵守规则：1.判断文件是电视剧集还是电影。2.对于电视剧，提取剧名、季号和集号。3.对于电影，提取电影名和上映年份。4. 'title'应为电视剧或电影的干净名称，删除所有附加信息。5.如果无法确定，将'type'设置为'unknown'。返回一个与所提供Schema匹配的JSON对象。`;
}

async function getMediaInfo(filename: string, parentDir: string): Promise<MediaInfo | null> {
  try {
    const { object } = await generateObject({
      model: google('models/gemini-1.5-flash'),
      schema: mediaInfoSchema,
      prompt: buildVideoPrompt(filename, parentDir),
    });
    return object;
  } catch (error) {
    console.error(`[错误] 在分析视频 "${filename}" 时调用AI失败:`, error);
    return null;
  }
}

export async function analyzeAndFormatFilename(originalFilename: string, parentDir: string): Promise<AnalysisResult> {
  const filenameWithoutExt = path.parse(originalFilename).name;
  const extension = path.parse(originalFilename).ext;

  if (!extension) return { newFilename: null, aiInfo: null };
  const info = await getMediaInfo(filenameWithoutExt, parentDir);
  if (!info) return { newFilename: null, aiInfo: null };

  const newFilename = formatNewFilename(info, extension);
  return { newFilename, aiInfo: info };
}

// --- 新增：辅助文件角色分析 ---

const auxFileRoleSchema = z.object({
  role: z.string().nullable().describe("文件的角色，例如 'thumb', 'poster', 'fanart', 'subtitle', 'nfo'。如果无法识别特殊角色，则为 null。"),
});

function buildAuxiliaryPrompt(standardBaseName: string, auxiliaryFilename: string): string {
  return `你是一个文件组织专家。你的任务是识别一个辅助文件的具体角色。
    - 标准文件名（不含后缀）: "${standardBaseName}"
    - 需要分析的辅助文件名: "${auxiliaryFilename}"

    请判断这个辅助文件的角色：
    - 如果是缩略图，返回 "thumb"。
    - 如果是海报，返回 "poster"。
    - 如果是粉丝艺术图，返回 "fanart"。
    - 如果是字幕文件 (.srt, .ass, .sup)，返回 "subtitle"。
    - 如果是信息文件 (.nfo)，返回 "nfo"。
    - 如果无法识别任何特殊角色，或它只是一个普通的同名文件，请返回 null。
    
    请只返回一个符合Schema的JSON对象。`;
}

/**
 * 新增函数：分析辅助文件的角色
 * @param standardBaseName - 标准化的基础文件名 (例如 "Rick and Morty - S01E01")
 * @param auxiliaryFilename - 原始的辅助文件名
 * @returns {Promise<string | null>} - 文件的角色或null
 */
export async function analyzeAuxiliaryFileRole(standardBaseName: string, auxiliaryFilename: string): Promise<string | null> {
  try {
    const { object } = await generateObject({
      model: google('models/gemini-1.5-flash'),
      schema: auxFileRoleSchema,
      prompt: buildAuxiliaryPrompt(standardBaseName, auxiliaryFilename),
    });
    return object.role;
  } catch (error) {
    console.error(`[错误] 在分析辅助文件 "${auxiliaryFilename}" 时调用AI失败:`, error);
    return null;
  }
}

// --- 通用函数 ---

function formatNewFilename(info: MediaInfo, originalExt: string): string | null {
  if (!info || !info.title || info.type === 'unknown') {
    return null;
  }
  const cleanTitle = info.title.replace(/[<>:"/\\|?*]/g, '').trim();
  if (info.type === 'show' && info.season != null && info.episode != null) {
    const seasonStr = String(info.season).padStart(2, '0');
    const episodeStr = String(info.episode).padStart(2, '0');
    return `${cleanTitle} - S${seasonStr}E${episodeStr}`;
  }
  if (info.type === 'movie' && info.year) {
    return `${cleanTitle} (${info.year})`;
  }
  if (info.type === 'movie') {
    return cleanTitle;
  }
  return null;
}
