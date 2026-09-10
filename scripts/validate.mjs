#!/usr/bin/env node
/**
 * Main validation script.
 * Runs all validation checks in sequence.
 * 
 * Status: IMPLEMENTED
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const validators = [
  { name: 'Repository Structure', script: 'validate-repo.mjs' },
  { name: 'Dependencies', script: 'validate-deps.mjs' }
];

function runValidator(name, script) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Running: ${name}`);
  console.log('='.repeat(50));
  
  try {
    execSync(`node ${path.join(__dirname, script)}`, {
      stdio: 'inherit',
      cwd: __dirname
    });
    return true;
  } catch (error) {
    console.error(`\n❌ ${name} validation failed`);
    return false;
  }
}

function main() {
  console.log('\n🔍 Zyvano Validation Suite');
  console.log('==========================\n');
  
  const results = validators.map(v => ({
    name: v.name,
    passed: runValidator(v.name, v.script)
  }));
  
  console.log(`\n\n${'='.repeat(50)}`);
  console.log('Validation Summary');
  console.log('='.repeat(50));
  
  results.forEach(r => {
    const status = r.passed ? '✅' : '❌';
    console.log(`${status} ${r.name}`);
  });
  
  const allPassed = results.every(r => r.passed);
  
  console.log('='.repeat(50));
  if (allPassed) {
    console.log('\n✅ All validations passed!');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some validations failed. Please review the output above.');
    process.exit(1);
  }
}

main();
