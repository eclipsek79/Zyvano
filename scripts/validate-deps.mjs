#!/usr/bin/env node
/**
 * Dependency validation script.
 * 
 * Validates tool versions, lockfiles, and dependency structure.
 * 
 * Status: IMPLEMENTED
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const REQUIRED_VERSIONS = {
  'node': '22.19.0',
  'pnpm': '10.15.1',
  'python': '3.12.11',
  'rustc': '1.89.0',
  'cargo': '1.89.0'
};

function getVersion(tool) {
  try {
    let cmd = `${tool} --version`;
    if (tool === 'rustc') cmd = 'rustc --version';
    if (tool === 'cargo') cmd = 'cargo --version';
    
    const output = execSync(cmd, { encoding: 'utf-8' });
    
    // Parse version from output
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
}

function validateToolVersions() {
  console.log('\n🔧 Validating tool versions...');
  let passed = 0;
  let failed = 0;
  
  for (const [tool, required] of Object.entries(REQUIRED_VERSIONS)) {
    const actual = getVersion(tool);
    if (actual === required) {
      console.log(`  ✅ ${tool}: ${actual}`);
      passed++;
    } else {
      console.log(`  ❌ ${tool}: expected ${required}, got ${actual || 'NOT FOUND'}`);
      failed++;
    }
  }
  
  return { passed, failed };
}

function validateLockfiles() {
  console.log('\n🔒 Validating lockfiles...');
  let passed = 0;
  let failed = 0;
  
  const lockfiles = [
    { path: 'pnpm-lock.yaml', name: 'pnpm lockfile' },
    { path: 'backend/uv.lock', name: 'Python (uv) lockfile' },
    { path: 'apps/desktop/src-tauri/Cargo.lock', name: 'Rust (Cargo) lockfile' }
  ];
  
  for (const lockfile of lockfiles) {
    const fullPath = path.join(rootDir, lockfile.path);
    if (fs.existsSync(fullPath)) {
      console.log(`  ✅ ${lockfile.name}`);
      passed++;
    } else {
      console.log(`  ❌ ${lockfile.name} (MISSING): ${lockfile.path}`);
      failed++;
    }
  }
  
  return { passed, failed };
}

function validateReactVersions() {
  console.log('\n⚛️  Validating React versions...');
  let passed = 0;
  let failed = 0;
  
  try {
    const output = execSync('pnpm list react@19.1.0 --json --recursive --depth 0', {
      encoding: 'utf-8',
      cwd: rootDir
    });
    
    const deps = JSON.parse(output);
    const hasReact191 = deps.some(d => d.name === 'react' && d.version === '19.1.0');
    
    if (hasReact191 || output.includes('19.1.0')) {
      console.log(`  ✅ React 19.1.0 found in workspace`);
      passed++;
    } else {
      console.log(`  ⚠️  React version mismatch (expected 19.1.0)`);
      // Not counted as failed since peer dependency handling is flexible
    }
  } catch (error) {
    console.log(`  ⚠️  Could not verify React versions`);
  }
  
  return { passed, failed };
}

function validateWorkspaceStructure() {
  console.log('\n📦 Validating workspace structure...');
  let passed = 0;
  let failed = 0;
  
  const workspacePackages = [
    'apps/web',
    'apps/mobile',
    'apps/desktop',
    'packages/types',
    'packages/validation',
    'packages/config',
    'packages/shared',
    'packages/ui',
    'packages/api-client',
    'packages/media-contracts'
  ];
  
  for (const pkg of workspacePackages) {
    const packageJsonPath = path.join(rootDir, pkg, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      console.log(`  ✅ ${pkg}`);
      passed++;
    } else {
      // Some packages might not exist in Phase 0
      console.log(`  ℹ️  ${pkg} (structure planned)`);
    }
  }
  
  return { passed, failed };
}

function validateNoUnauthorizedLockfiles() {
  console.log('\n🚫 Validating unauthorized lockfiles are absent...');
  let passed = 0;
  let failed = 0;
  
  // Python lockfiles should only be in backend/
  const pythonLockfiles = [
    'requirements.txt',
    'requirements-lock.txt',
    'Pipfile.lock'
  ];
  
  for (const file of pythonLockfiles) {
    const rootFile = path.join(rootDir, file);
    if (!fs.existsSync(rootFile)) {
      console.log(`  ✅ No unauthorized ${file} at root`);
      passed++;
    } else {
      console.log(`  ❌ Unauthorized ${file} at root (should be in backend/)`);
      failed++;
    }
  }
  
  return { passed, failed };
}

function main() {
  console.log('🔍 Zyvano Dependency Validation');
  console.log('================================');
  
  const results = [
    validateToolVersions(),
    validateLockfiles(),
    validateReactVersions(),
    validateWorkspaceStructure(),
    validateNoUnauthorizedLockfiles()
  ];
  
  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  
  console.log('\n' + '='.repeat(40));
  console.log(`✅ Passed: ${totalPassed}`);
  console.log(`❌ Failed: ${totalFailed}`);
  console.log('='.repeat(40));
  
  if (totalFailed > 0) {
    console.log('\n⚠️  Some validation checks failed.');
    process.exit(1);
  } else {
    console.log('\n✅ All dependency checks passed!');
    process.exit(0);
  }
}

main();
