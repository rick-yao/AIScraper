import path from 'path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import { StatsCollector } from './stats.js'; // 导入统计收集器

process.on('unhandledRejection', (reason, promise) => {
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.error('!!!     未处理的PROMISE拒绝     !!!');
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.error('原因:', reason);
});

const API_KEY = process.env.AI_SCRAPER_API_KEY;
if (!API_KEY) {
  console.error("致命错误: 环境变量 AI_SCRAPER_API_KEY 未设置。");
  process.exit(1);
}
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

// ++++++++++ 修改：优化视频分析的指令 ++++++++++
function buildVideoPrompt(filename: string, parentDir: string): string {
  return `你是一个为Plex和Jellyfin服务的媒体文件整理专家。你的任务是从一个复杂的文件或目录名中，准确地提取出剧集或电影的官方名称。

  请分析以下信息：
  - 文件名: "${filename}"
  - 父目录: "${parentDir}"

  请严格遵守以下规则:
  1. 核心任务是识别出**最主要的、最官方的那个标题**。文件名或目录名的开头部分通常包含了标题。
  2. 标题可能同时包含**中文和英文**名称，并用点（.）分隔。例如，在 "苦尽柑来遇见你.When.Life.Gives.You.Tangerines.2025..." 这个例子中，"When Life Gives You Tangerines" 是更适合作为官方刮削的英文标题，请优先选择它。
  3. 返回的 'title' 字段**必须**是干净的、被识别出的官方标题，不含任何技术参数、发布组信息、年份或其他语言的别名。
  4. 提取季号（Season/S）和集号（Episode/E）。
  5. 提取上映年份（通常是4位数字）。
  6. 如果无法确定任何有效信息，将 'type' 设置为 'unknown'。

  请返回一个与所提供Schema完全匹配的JSON对象，不要添加任何额外的文本或解释。`;
}
// +++++++++++++++++++++++++++++++++++++++++++++

// 修改：增加 stats 参数
async function getMediaInfo(filename: string, parentDir: string, stats: StatsCollector): Promise<MediaInfo | null> {
  try {
    const { object, usage } = await generateObject({
      model: google('models/gemini-1.5-flash'),
      schema: mediaInfoSchema,
      prompt: buildVideoPrompt(filename, parentDir),
    });
    stats.addRequest(usage); // 记录 token 使用情况
    return object;
  } catch (error) {
    console.error(`[错误] 在分析视频 "${filename}" 时调用AI失败:`, error);
    return null;
  }
}

// 修改：增加 stats 参数并传递下去
export async function analyzeAndFormatFilename(originalFilename: string, parentDir: string, stats: StatsCollector): Promise<AnalysisResult> {
  const filenameWithoutExt = path.parse(originalFilename).name;
  const extension = path.parse(originalFilename).ext;

  if (!extension) return { newFilename: null, aiInfo: null };
  const info = await getMediaInfo(filenameWithoutExt, parentDir, stats);
  if (!info) return { newFilename: null, aiInfo: null };

  const newFilename = formatNewFilename(info, extension);
  return { newFilename, aiInfo: info };
}

// --- 辅助文件角色分析 ---

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

// 修改：增加 stats 参数
export async function analyzeAuxiliaryFileRole(standardBaseName: string, auxiliaryFilename: string, stats: StatsCollector): Promise<string | null> {
  try {
    const { object, usage } = await generateObject({
      model: google('models/gemini-1.5-flash'),
      schema: auxFileRoleSchema,
      prompt: buildAuxiliaryPrompt(standardBaseName, auxiliaryFilename),
    });
    stats.addRequest(usage); // 记录 token 使用情况
    return object.role;
  } catch (error) {
    console.error(`[错误] 在分析辅助文件 "${auxiliaryFilename}" 时调用AI失败:`, error);
    return null;
  }
}

// --- 宏观标题整理 ---

const canonicalTitleSchema = z.record(z.string(), z.string().describe("最终的、标准的英文剧集标题。"));

function buildCanonicalTitlePrompt(titles: string[]): string {
  return `你是一个媒体库整理专家。这里有一个从文件名中提取出的剧集标题列表，其中可能包含同一部剧集的多种语言或不同命名方式。
  你的任务是将它们分组，并为每一组确定一个唯一的、标准的英文名称作为“官方标题”。

  标题列表:
  ${titles.map(t => `- ${t}`).join('\n')}

  请返回一个JSON对象，其中每个键是原始列表中的一个标题，其对应的值是该标题所属剧集的“官方标题”。
  例如，如果输入包含 "瑞克和莫蒂" 和 "Rick and Morty"，你的返回应该类似 {"瑞克和莫蒂": "Rick and Morty", "Rick and Morty": "Rick and Morty"}。
  对于像 "DAN.DA.DAN" 和 "DAN DA DAN" 这样的，请统一为 "Dan Da Dan"。`;
}

// 修改：增加 stats 参数
export async function getCanonicalTitleMapping(titles: string[], stats: StatsCollector): Promise<Record<string, string> | null> {
  try {
    const { object, usage } = await generateObject({
      model: google('models/gemini-1.5-flash'),
      schema: canonicalTitleSchema,
      prompt: buildCanonicalTitlePrompt(titles),
      mode: 'json'
    });
    stats.addRequest(usage); // 记录 token 使用情况
    return object;
  } catch (error) {
    console.error('[错误] 在进行宏观标题整理时调用 AI 失败:', error);
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
    // 同样移除这里的 '-' 分隔符以匹配新规则
    return `${cleanTitle} S${seasonStr}E${episodeStr}`;
  }
  if (info.type === 'movie' && info.year) {
    return `${cleanTitle} (${info.year})`;
  }
  if (info.type === 'movie') {
    return cleanTitle;
  }
  return null;
}
