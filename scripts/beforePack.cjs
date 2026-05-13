const fs = require('fs');
const path = require('path');

/**
 * Clean up node_modules before packaging to reduce app size
 * Removes ALL node_modules except uiohook-napi and node-gyp-build
 */
module.exports = async function beforePack(context) {
  console.log('[beforePack] Cleaning up node_modules to reduce app size...');
  
  // beforePack runs AFTER electron-builder copies files to temp directory (appDir)
  // We MUST only clean the temp directory, NEVER the source directory
  // Cleaning the source would break the build process
  const appDir = context.appDir || context.packager?.info?.appDir;
  const projectDir = process.cwd();
  
  if (!appDir) {
    console.log('[beforePack] No appDir (temp directory) found, skipping cleanup');
    console.log('[beforePack] This is normal - electron-builder will handle file copying');
    return;
  }
  
  // CRITICAL: Check if appDir is actually the source directory (project root)
  // If it is, skip cleanup to avoid breaking the build process
  const normalizedAppDir = path.resolve(appDir);
  const normalizedProjectDir = path.resolve(projectDir);
  
  // CRITICAL: NEVER clean the source directory
  // If appDir equals projectDir, electron-builder is using the source directly
  // In this case, we must skip cleanup to avoid breaking the build
  if (normalizedAppDir === normalizedProjectDir) {
    console.log('[beforePack] appDir is the source directory, skipping cleanup');
    console.log('[beforePack] This prevents accidentally removing build tools from source');
    console.log('[beforePack] NOTE: If node_modules are being included, check the "files" array in package.json');
    return;
  }
  
  const nodeModulesPath = path.join(appDir, 'node_modules');
  
  console.log(`[beforePack] Temp directory (appDir): ${appDir}`);
  console.log(`[beforePack] Project directory: ${projectDir}`);
  console.log(`[beforePack] Cleaning node_modules at: ${nodeModulesPath}`);
  
  if (!fs.existsSync(nodeModulesPath)) {
    console.log('[beforePack] node_modules not found in temp directory, skipping cleanup');
    return;
  }
  
  // Calculate initial size
  function getDirSize(dir) {
    let size = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            size += getDirSize(fullPath);
          } else {
            const stats = fs.statSync(fullPath);
            size += stats.size;
          }
        } catch (e) {}
      }
    } catch (e) {}
    return size;
  }
  
  const initialSize = getDirSize(nodeModulesPath);
  console.log(`[beforePack] Initial node_modules size: ${(initialSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
  
  // Packages that MUST be kept (native modules needed at runtime)
  const keepPackages = new Set([
    'uiohook-napi',
    'node-gyp-build',
  ]);
  
  // Remove ALL node_modules except the ones we need
  console.log('[beforePack] Removing unnecessary node_modules packages...');
  const entries = fs.readdirSync(nodeModulesPath, { withFileTypes: true });
  let removedCount = 0;
  let keptCount = 0;
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const packageName = entry.name;
      const fullPath = path.join(nodeModulesPath, packageName);
      
      // Check if this is a package we need to keep
      const shouldKeep = keepPackages.has(packageName);
      
      if (!shouldKeep) {
        try {
          // Remove everything - scoped packages (@scope) and regular packages
          console.log(`[beforePack] Removing: ${packageName}`);
          fs.rmSync(fullPath, { recursive: true, force: true });
          removedCount++;
        } catch (error) {
          console.warn(`[beforePack] Failed to remove ${fullPath}:`, error.message);
        }
      } else {
        keptCount++;
        console.log(`[beforePack] Keeping: ${packageName}`);
      }
    }
  }
  
  console.log(`[beforePack] Removed ${removedCount} packages, kept ${keptCount} packages`);
  
  const finalSize = getDirSize(nodeModulesPath);
  const saved = initialSize - finalSize;
  console.log(`[beforePack] Final node_modules size: ${(finalSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`[beforePack] Space saved: ${(saved / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log('[beforePack] Cleanup complete!');
};





