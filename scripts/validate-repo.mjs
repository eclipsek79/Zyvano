#!/usr/bin/env node
/**
 * Repository structure validation script.
 * 
 * Validates that the repository maintains expected structure and conventions.
 * 
 * Status: IMPLEMENTED
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const requiredFiles = [
  'README.md',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'turbo.json',
  '.gitignore',
  '.env.example',
  '.tool-versions',
  'docs/ARCHITECTURE.md',
  'docs/API.md',
  'docs/DATABASE.md',
  'docs/DEPENDENCIES.md',
  'docs/DEVELOPMENT.md',
  'docs/SECURITY.md'
];

const requiredDirectories = [
  'apps',
  'packages',
  'database',
  'docs',
  'scripts',
  'backend',
  'infrastructure',
  '.github'
];

function validateFiles() {
  console.log('\n📋 Validating required files...');
  let passed = 0;
  let failed = 0;
  
  for (const file of requiredFiles) {
    const filePath = path.join(rootDir, file);
    if (fs.existsSync(filePath)) {
      console.log(`  ✅ ${file}`);
      passed++;
    } else {
      console.log(`  ❌ ${file} (MISSING)`);
      failed++;
    }
  }
  
  return { passed, failed };
}

function validateDirectories() {
  console.log('\n📁 Validating required directories...');
  let passed = 0;
  let failed = 0;
  
  for (const dir of requiredDirectories) {
    const dirPath = path.join(rootDir, dir);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      console.log(`  ✅ ${dir}/`);
      passed++;
    } else {
      console.log(`  ❌ ${dir}/ (MISSING)`);
      failed++;
    }
  }
  
  return { passed, failed };
}

function validateGitignore() {
  console.log('\n🚫 Validating .gitignore...');
  const gitignorePath = path.join(rootDir, '.gitignore');
  const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
  
  const requiredPatterns = [
    'node_modules/',
    '.env',
    '.env.local',
    '.vscode/',
    '.idea/',
    'dist/',
    'build/',
    'coverage/',
    'target/',
    '__pycache__/'
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const pattern of requiredPatterns) {
    if (gitignoreContent.includes(pattern)) {
      console.log(`  ✅ ${pattern}`);
      passed++;
    } else {
      console.log(`  ❌ ${pattern} (NOT FOUND)`);
      failed++;
    }
  }
  
  return { passed, failed };
}

function validatePackageJson() {
  console.log('\n📦 Validating package.json...');
  const packagePath = path.join(rootDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
  
  let passed = 0;
  let failed = 0;
  
  const requiredFields = ['name', 'version', 'private', 'type'];
  for (const field of requiredFields) {
    if (field in packageJson) {
      console.log(`  ✅ ${field}: ${JSON.stringify(packageJson[field])}`);
      passed++;
    } else {
      console.log(`  ❌ ${field} (MISSING)`);
      failed++;
    }
  }
  
  return { passed, failed };
}

function main() {
  console.log('🔍 Zyvano Repository Validation');
  console.log('================================');
  
  const results = [
    validateFiles(),
    validateDirectories(),
    validateGitignore(),
    validatePackageJson()
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
    console.log('\n✅ All validation checks passed!');
    process.exit(0);
  }
}

main();
