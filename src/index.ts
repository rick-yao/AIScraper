import { Command } from 'commander';
import path from 'path';
import fs from 'fs/promises';
import { organizeMediaLibrary } from './organizer.js';

const program = new Command();

program
  .version('2.2.0') // 版本升级，支持预检
  .description('使用AI并行整理媒体文件，并在执行前进行预检，确保权限和路径正确。')
  .requiredOption('-s, --source <path>', '源文件夹路径')
  .requiredOption('-t, --target <path>', '用于存放软链接的目标文件夹路径')
  .option('-c, --concurrency <number>', '并行处理的并发请求数', '10')
  .option('--debug', '启用调试模式，不会创建软链接，而是生成一个包含整理计划的JSON文件');

program.parse(process.argv);

const options = program.opts();

const sourcePath = path.resolve(options.source);
const targetPath = path.resolve(options.target);
const isDebugMode = !!options.debug;
const concurrency = parseInt(options.concurrency, 10);

/**
 * 执行预检，确保所有条件都满足后再开始主要任务
 * @param sourceDir - 源目录路径
 * @param targetDir - 目标目录路径
 * @returns {Promise<boolean>} - 如果所有检查都通过，则返回 true
 */
async function preflightCheck(sourceDir: string, targetDir: string): Promise<boolean> {
  console.log('--- 开始执行预检 ---');
  let checksPassed = true;

  // 1. 检查 API 密钥
  if (!process.env.AI_SCRAPER_API_KEY) {
    console.error('[预检失败] 致命错误: 环境变量 AI_SCRAPER_API_KEY 未设置。');
    checksPassed = false;
  } else {
    console.log('[预检通过] 1/3: AI_SCRAPER_API_KEY 已设置。');
  }

  // 2. 检查源目录是否可读
  try {
    await fs.access(sourceDir, fs.constants.R_OK);
    console.log('[预检通过] 2/3: 源目录存在且可读。');
  } catch (error) {
    console.error(`[预检失败] 无法访问或读取源目录: ${sourceDir}`, error);
    checksPassed = false;
  }

  // 3. 检查目标目录是否可写
  try {
    // 尝试创建目标目录（如果不存在）
    await fs.mkdir(targetDir, { recursive: true });

    // 尝试在目标目录中创建一个临时文件来测试写入权限
    const testFile = path.join(targetDir, `.permission_test_${Date.now()}`);
    await fs.writeFile(testFile, 'test');
    await fs.unlink(testFile); // 测试后立即删除
    console.log('[预检通过] 3/3: 目标目录存在且可写。');

  } catch (error) {
    console.error(`[预检失败] 无法写入目标目录: ${targetDir}`, error);
    console.error('请检查路径是否正确以及您是否拥有该目录的写入权限。');
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
  console.log(`源路径: ${sourcePath}`);
  console.log(`目标路径: ${targetPath}`);
  console.log(`并行数: ${concurrency}`);

  // 在开始任何操作之前执行预检
  const checksOk = await preflightCheck(sourcePath, targetPath);
  if (!checksOk) {
    process.exit(1); // 如果预检失败，则退出程序
  }

  console.log("\n一切就绪，准备开始整理媒体库...");

  if (isDebugMode) {
    console.log('*** 调试模式已启用 ***');
    console.log('将不会创建任何文件或目录，仅生成调试日志。');
  }

  // 调用核心整理函数
  await organizeMediaLibrary(sourcePath, targetPath, isDebugMode, concurrency);

  console.log('\n处理完成。');
}

main().catch(error => {
  console.error('\n发生意外错误:', error);
  process.exit(1);
});
