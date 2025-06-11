import { Command } from 'commander';
import path from 'path';
import fs from 'fs/promises';
import { organizeMediaLibrary } from './organizer.js';

const program = new Command();

// 使用 program.helpOption()来自定义帮助命令
program
  .version('2.3.0') // 版本升级，支持更灵活的链接选项
  .description('使用AI并行整理媒体文件，合并系列，并为Jellyfin创建标准化的软/硬链接。')
  // 更新：source 现在可以接收一个或多个路径
  .requiredOption('-s, --source <paths...>', '一个或多个源文件夹路径')
  .requiredOption('-t, --target <path>', '用于存放链接的目标文件夹路径')
  // 新增：链接类型选项
  .option('-l, --link-type <type>', '创建的链接类型 (soft 或 hard)', 'soft')
  // 新增：路径模式选项
  .option('-p, --path-mode <mode>', '链接的路径模式 (absolute 或 relative)', 'absolute')
  .option('-c, --concurrency <number>', '并行处理的并发请求数', '10')
  .option('--debug', '启用调试模式，不会创建软链接，而是生成一个包含整理计划的JSON文件')
  // 新增：自定义帮助选项
  .helpOption('-h, --help', '显示帮助信息');

program.parse(process.argv);

const options = program.opts();

// options.source 现在是一个数组
const sourcePaths = options.source.map((p: string) => path.resolve(p));
const targetPath = path.resolve(options.target);
const isDebugMode = !!options.debug;
const concurrency = parseInt(options.concurrency, 10);
const linkType = options.linkType;
const pathMode = options.pathMode;

/**
 * 执行预检
 */
async function preflightCheck(sourceDirs: string[], targetDir: string): Promise<boolean> {
  console.log('--- 开始执行预检 ---');
  let checksPassed = true;

  // 1. 检查 API 密钥
  if (!process.env.AI_SCRAPER_API_KEY) {
    console.error('[预检失败] 致命错误: 环境变量 AI_SCRAPER_API_KEY 未设置。');
    return false;
  }
  console.log('[预检通过] 1/3: API 密钥已设置。');

  // 2. 检查所有源目录是否可读
  let allSourcesOk = true;
  for (const sourceDir of sourceDirs) {
    try {
      await fs.access(sourceDir, fs.constants.R_OK);
    } catch (error) {
      console.error(`[预检失败] 无法访问或读取源目录: ${sourceDir}`);
      allSourcesOk = false;
    }
  }
  if (allSourcesOk) {
    console.log('[预检通过] 2/3: 所有源目录均存在且可读。');
  } else {
    checksPassed = false;
  }

  // 3. 检查目标目录是否可写
  try {
    await fs.mkdir(targetDir, { recursive: true });
    const testFile = path.join(targetDir, `.permission_test_${Date.now()}`);
    await fs.writeFile(testFile, 'test');
    await fs.unlink(testFile);
    console.log('[预检通过] 3/3: 目标目录存在且可写。');
  } catch (error) {
    console.error(`[预检失败] 无法写入目标目录: ${targetDir}`, error);
    checksPassed = false;
  }

  // 4. 检查选项是否合法
  if (!['soft', 'hard'].includes(linkType)) {
    console.error(`[预检失败] 无效的链接类型: "${linkType}"。请使用 "soft" 或 "hard"。`);
    checksPassed = false;
  }
  if (!['absolute', 'relative'].includes(pathMode)) {
    console.error(`[预检失败] 无效的路径模式: "${pathMode}"。请使用 "absolute" 或 "relative"。`);
    checksPassed = false;
  }

  if (checksPassed) {
    console.log('--- 所有预检项均已通过 ---');
  } else {
    console.log('--- 预检失败，程序将不会执行 ---');
  }

  return checksPassed;
}

/**
 * 主函数
 */
async function main() {
  console.log(`源路径: ${sourcePaths.join(', ')}`);
  console.log(`目标路径: ${targetPath}`);
  console.log(`链接类型: ${linkType}, 路径模式: ${pathMode}`);
  console.log(`并行数: ${concurrency}`);

  const checksOk = await preflightCheck(sourcePaths, targetPath);
  if (!checksOk) {
    process.exit(1);
  }

  console.log("\n一切就绪，准备开始整理媒体库...");

  if (isDebugMode) {
    console.log('*** 调试模式已启用 ***');
  }

  // 将所有新选项传递给核心整理函数
  await organizeMediaLibrary(sourcePaths, targetPath, isDebugMode, concurrency, linkType, pathMode);

  console.log('\n处理完成。');
}

main().catch(error => {
  console.error('\n发生意外错误:', error);
  process.exit(1);
});
