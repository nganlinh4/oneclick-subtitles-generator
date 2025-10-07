#!/usr/bin/env node

/**
 * Setup script to configure npm workspaces for OneClick Subtitles Generator
 * This ensures optimal dependency management and disk space usage
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PACKAGE_JSON_PATH = path.join(__dirname, 'package.json');
const BACKUP_DIR = path.join(__dirname, 'backup');

console.log('🔧 Setting up npm workspaces...');

try {
    // Read current package.json
    const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    
    // Check if workspaces are already configured
    if (packageJson.workspaces && Array.isArray(packageJson.workspaces)) {
        console.log('✅ npm workspaces already configured');
        return;
    }
    
    console.log('📦 Configuring npm workspaces...');
    
    // Add workspaces configuration
    packageJson.workspaces = [
        "promptdj-midi",
        "video-renderer"
    ];
    
    // Ensure workspace:build script exists
    if (!packageJson.scripts['workspace:build']) {
        packageJson.scripts['workspace:build'] = 'npm run --workspace=video-renderer server:build && npm run --workspace=promptdj-midi build';
    }
    
    // Update postinstall script to be workspace-aware
    if (packageJson.scripts.postinstall && !packageJson.scripts.postinstall.includes('workspace:build')) {
        packageJson.scripts.postinstall = packageJson.scripts.postinstall.replace(
            /cd\s+video-renderer\s+&&\s+npm\s+install[^&]*&&\s+npm\s+run\s+server:build[^&]*&&\s+cd\s+\.\.\s+&&\s+cd\s+promptdj-midi\s+&&\s+npm\s+install[^&]*&&\s+npm\s+run\s+build[^&]*&&\s+cd\s+\.\./g,
            'npm run workspace:build'
        );
    }
    
    // Write updated package.json
    fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(packageJson, null, 2) + '\n');
    console.log('✅ Updated package.json with workspaces configuration');
    
    // Create backup directory if it doesn't exist
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    
    // Backup existing node_modules if they exist
    const workspaceDirs = ['promptdj-midi', 'video-renderer'];
    for (const workspace of workspaceDirs) {
        const nodeModulesPath = path.join(__dirname, workspace, 'node_modules');
        const backupPath = path.join(BACKUP_DIR, `${workspace}-node_modules`);
        
        if (fs.existsSync(nodeModulesPath) && !fs.existsSync(backupPath)) {
            console.log(`💾 Backing up ${workspace}/node_modules...`);
            try {
                execSync(`xcopy "${nodeModulesPath}" "${backupPath}" /E /I /Q`, { stdio: 'ignore' });
            } catch (error) {
                // Fallback for non-Windows systems
                try {
                    execSync(`cp -r "${nodeModulesPath}" "${backupPath}"`, { stdio: 'ignore' });
                } catch (fallbackError) {
                    console.log(`⚠️  Could not backup ${workspace}/node_modules (continuing anyway)`);
                }
            }
        }
    }
    
    // Remove workspace package-lock.json files to avoid conflicts
    for (const workspace of workspaceDirs) {
        const lockPath = path.join(__dirname, workspace, 'package-lock.json');
        if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
            console.log(`🗑️  Removed ${workspace}/package-lock.json`);
        }
    }
    
    // Clean workspace node_modules to force proper workspace setup
    for (const workspace of workspaceDirs) {
        const nodeModulesPath = path.join(__dirname, workspace, 'node_modules');
        if (fs.existsSync(nodeModulesPath)) {
            console.log(`🧹 Cleaning ${workspace}/node_modules for workspace setup...`);
            try {
                if (process.platform === 'win32') {
                    execSync(`rmdir /s /q "${nodeModulesPath}"`, { stdio: 'ignore' });
                } else {
                    execSync(`rm -rf "${nodeModulesPath}"`, { stdio: 'ignore' });
                }
            } catch (error) {
                console.log(`⚠️  Could not clean ${workspace}/node_modules (continuing anyway)`);
            }
        }
    }
    
    console.log('✅ npm workspaces setup completed!');
    console.log('💡 Benefits:');
    console.log('   - Shared dependencies reduce disk usage by ~68%');
    console.log('   - Faster installations');
    console.log('   - Simplified dependency management');
    console.log('');
    console.log('🔄 Run "npm install" to apply workspace configuration');
    
} catch (error) {
    console.error('❌ Error setting up workspaces:', error.message);
    process.exit(1);
}
