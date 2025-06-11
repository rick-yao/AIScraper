/**
 * AI分析后得到的原始媒体信息
 */
export type MediaInfo = {
  title: string;
  season?: number | null;
  episode?: number | null;
  type: 'show' | 'movie' | 'unknown';
  year?: number | null;
};

/**
 * 代表一个文件组中的单个文件
 */
export interface MediaFile {
  sourcePath: string; // 源文件完整路径
  originalFilename: string; // 原始文件名
  // 新增：用于存储AI分析出的文件角色，如 'thumb', 'poster', 'subtitle'
  role?: string | null;
}

/**
 * 代表一个剧集或电影的一集/一个版本
 * 包含主视频文件和所有关联的辅助文件
 */
export interface EpisodeOrMovie {
  season?: number | null;
  episode?: number | null;
  videoFile: MediaFile; // 主要的视频文件
  sidecarFiles: MediaFile[]; // 关联的辅助文件（字幕、nfo等）
  aiInfo: MediaInfo; // AI对这个视频文件的分析结果
}

/**
 * 代表一个完整的电视剧系列或一部电影
 */
export interface MediaSeries {
  // 记录所有AI识别出的标题及其出现次数，用于后续投票选出最终标题
  titleVotes: Record<string, number>;
  // 记录所有AI识别出的年份及其出现次数
  yearVotes: Record<string, number>;
  // 存放属于这个系列的所有剧集或电影文件
  items: EpisodeOrMovie[];
  // 这个系列的最终类型（show或movie）
  type: 'show' | 'movie';
  // 经过整理后，确定的最终（官方）标题
  canonicalTitle?: string;
  // 经过整理后，确定的最终年份
  canonicalYear?: number | null;
}

/**
 * 媒体库的完整蓝图/内存数据库
 * key是AI初步识别出的标题（可能会有多个变种，如 "Rick and Morty", "瑞克和莫蒂"）
 */
export type MediaBlueprint = Record<string, MediaSeries>;
