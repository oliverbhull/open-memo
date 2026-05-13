const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('fs');

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { stdio: 'inherit', ...opts }, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({ stdout, stderr });
    });
  });
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  
  // Clean up node_modules from app.asar to reduce size
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  if (fs.existsSync(asarPath)) {
    console.log('[afterPack] Cleaning node_modules from app.asar...');
    try {
      const { execSync } = require('child_process');
      const tempDir = path.join(context.appOutDir, '.asar-temp');
      
      // Extract asar
      execSync(`npx asar extract "${asarPath}" "${tempDir}"`, { stdio: 'inherit' });
      
      // Remove unnecessary node_modules
      const nodeModulesPath = path.join(tempDir, 'node_modules');
      if (fs.existsSync(nodeModulesPath)) {
        // Keep native modules and their dependencies
        const keepPackages = new Set([
          'uiohook-napi', 
          'node-gyp-build',
        ]);
        
        const entries = fs.readdirSync(nodeModulesPath, { withFileTypes: true });
        console.log(`[afterPack] Found ${entries.length} packages in node_modules`);
        
        const keptPackages = [];
        let removed = 0;
        
        for (const entry of entries) {
          if (!entry.isDirectory()) {
            continue; // Skip files, only process directories
          }
          
          const packageName = entry.name;
          const shouldKeep = keepPackages.has(packageName);
          
          if (shouldKeep) {
            keptPackages.push(packageName);
          } else {
            fs.rmSync(path.join(nodeModulesPath, packageName), { recursive: true, force: true });
            removed++;
          }
        }
        
        console.log(`[afterPack] Kept ${keptPackages.length} packages: ${keptPackages.join(', ')}`);
        console.log(`[afterPack] Removed ${removed} packages from app.asar`);
        
        // Verify critical packages are still present
        const criticalPackages = [
          { name: 'uiohook-napi', path: 'uiohook-napi' },
          { name: 'node-gyp-build', path: 'node-gyp-build' },
        ];
        const missingPackages = [];
        const foundPackages = [];
        
        for (const critical of criticalPackages) {
          const checkPath = path.join(nodeModulesPath, critical.path);
          if (!fs.existsSync(checkPath)) {
            missingPackages.push(critical.name);
            console.warn(`[afterPack] ⚠️  Not found in asar: ${critical.name} at ${checkPath}`);
          } else {
            foundPackages.push(critical.name);
            console.log(`[afterPack] ✅ Verified: ${critical.name} exists`);
          }
        }
        
        // Handle missing packages gracefully
        // Native modules are often excluded from asar by electron-builder and placed outside
        // This is expected behavior, so we only warn, not error
        if (missingPackages.length > 0) {
          if (removed > 0) {
            // We removed packages, so the native modules should have been there
            // But they might be outside asar, which is fine
            console.warn(`[afterPack] ⚠️  Native modules not in asar (may be outside asar): ${missingPackages.join(', ')}`);
            console.warn(`[afterPack] This is usually fine - electron-builder often places native modules outside app.asar`);
          } else {
            // We didn't remove anything, so they were never included (excluded by electron-builder)
            console.warn(`[afterPack] ⚠️  Native modules excluded from asar by electron-builder: ${missingPackages.join(', ')}`);
            console.warn(`[afterPack] This is expected - native modules are typically placed outside app.asar`);
          }
        }
        
        if (foundPackages.length > 0) {
          console.log(`[afterPack] ✅ Found ${foundPackages.length} critical package(s) in asar: ${foundPackages.join(', ')}`);
        }
        
        // Don't throw error - native modules outside asar is valid
        // The app will still work if native modules are in the app bundle outside asar
      }
      
      // Repack asar
      execSync(`npx asar pack "${tempDir}" "${asarPath}"`, { stdio: 'inherit' });
      
      // Cleanup temp directory
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log('[afterPack] ✅ Cleaned app.asar successfully');
    } catch (error) {
      console.warn('[afterPack] Failed to clean app.asar:', error.message);
    }
  }
  
  // Copy memo-stt binary to the app bundle (if not already in extraResources)
  try {
    const targetPath = path.join(appPath, 'Contents', 'Resources', 'sttbin', 'memo-stt');
    
    // Check if binary already exists (from extraResources)
    if (!fs.existsSync(targetPath)) {
      console.log('⚠ memo-stt binary not found in app bundle, attempting to copy...');
      
      // Ensure the target directory exists
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
        console.log('Created target directory:', targetDir);
      }
      
      // Try locations in order of preference
      const sourcePaths = [
        // Stable output from scripts/shell/build-stt.sh
        path.join(context.packager.info.appDir, '.build', 'stt', 'memo-stt'),
        path.join(context.appOutDir, 'sttbin', 'memo-stt'),
      ];
      
      let copied = false;
      for (const sourcePath of sourcePaths) {
        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, targetPath);
          console.log('✓ memo-stt binary copied to app bundle from:', sourcePath);
          copied = true;
          break;
        } else {
          console.log('  - Not found:', sourcePath);
        }
      }
      
      if (!copied) {
        console.error('❌ CRITICAL: memo-stt binary not found in any expected location!');
        console.error('Searched locations:');
        sourcePaths.forEach(p => console.error(`  - ${p}`));
        throw new Error('memo-stt binary is required but not found');
      }
    } else {
      console.log('✓ memo-stt binary already in app bundle (from extraResources)');
    }
    
    // Verify binary exists and is executable
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath);
      console.log(`✓ Binary verified: size=${stats.size} bytes, mode=${stats.mode.toString(8)}`);
      
      // Ensure executable bit is set
      if ((stats.mode & parseInt('111', 8)) === 0) {
        console.log('⚠ Binary is not executable, fixing...');
        fs.chmodSync(targetPath, 0o755);
        console.log('✓ Set binary permissions to 755');
      }
    } else {
      throw new Error('Binary verification failed: file does not exist after copy');
    }
  } catch (error) {
    console.error('❌ Failed to copy/verify memo-stt binary:', error);
    throw error; // Fail the build if binary is missing
  }
  
      // Clean extended attributes to prevent code signing issues
      try {
        console.log('Cleaning extended attributes from app bundle...');
        // Clean entire app bundle first
        await sh('xattr', ['-cr', appPath]);
        await sh('dot_clean', ['-m', appPath]).catch(() => {});

        // Explicitly scrub Helper apps and their binaries
        const helpers = [
          'Memo Helper.app',
          'Memo Helper (GPU).app',
          'Memo Helper (Plugin).app',
          'Memo Helper (Renderer).app',
        ];
        for (const helper of helpers) {
          const helperApp = path.join(appPath, 'Contents', 'Frameworks', helper);
          const helperBin = path.join(helperApp, 'Contents', 'MacOS', helper.replace('.app', ''));
          await sh('xattr', ['-cr', helperApp]).catch(() => {});
          await sh('xattr', ['-cr', helperBin]).catch(() => {});
        }

        console.log('Extended attributes cleaned successfully');
      } catch (error) {
        console.error('Failed to clean extended attributes:', error);
      }

  // Sign the memo-stt binary with entitlements BEFORE the main app is signed
  // This is critical for microphone access in production builds
  try {
    const sttBinPath = path.join(appPath, 'Contents', 'Resources', 'sttbin', 'memo-stt');
    
    if (fs.existsSync(sttBinPath)) {
      console.log('Signing memo-stt binary with microphone entitlements...');
      
      // Ensure executable bit
      await sh('chmod', ['+x', sttBinPath]);
      
      // Get entitlements file
      const entitlements = path.resolve('config/entitlements.mac.plist');
      
      // Get signing identity (use environment variable or default)
      const signer = process.env.CSC_NAME || process.env.CODE_SIGN_IDENTITY || 'Developer ID Application';
      
      // Only sign if we have a valid signing identity (skip in unsigned builds)
      if (process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false' && process.env.MANUAL_SIGN !== '1') {
        // Sign the memo-stt binary with hardened runtime and entitlements
        await sh('codesign', [
          '--force',
          '--options', 'runtime',
          '--entitlements', entitlements,
          '--sign', signer,
          sttBinPath
        ]);
        
        // Verify the signature
        await sh('codesign', ['--verify', '--verbose', sttBinPath]);
        console.log('✓ memo-stt binary signed successfully with microphone entitlements');
      } else {
        console.log('⚠ Skipping memo-stt binary signing (unsigned build)');
      }
    } else {
      console.warn('⚠ memo-stt binary not found at:', sttBinPath);
    }
  } catch (error) {
    console.error('Failed to sign memo-stt binary:', error);
    // Don't fail the build if signing fails (might be unsigned build)
    if (process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false') {
      console.warn('⚠ memo-stt binary signing failed, but continuing build');
    }
  }
};


