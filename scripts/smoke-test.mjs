import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rootDir = process.cwd();

console.log('Packing package artifact via npm pack...');
const packOutput = execSync('npm pack --json', { encoding: 'utf-8', cwd: rootDir });
const packInfo = JSON.parse(packOutput);
const tarballName = packInfo[0].filename;
const tarballPath = path.resolve(rootDir, tarballName);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorowill-smoke-'));

try {
  console.log(`Setting up smoke test environment in ${tempDir}...`);
  fs.writeFileSync(
    path.join(tempDir, 'package.json'),
    JSON.stringify({ name: 'smoke-test-runner', version: '1.0.0', type: 'module' }),
  );

  console.log(`Installing packed archive ${tarballPath}...`);
  execSync(`npm install "${tarballPath}" --no-save`, { cwd: tempDir, stdio: 'inherit' });

  console.log('Running ESM entry points smoke test...');
  const esmScript = `
import assert from 'node:assert';
import {
  SoroWillClient,
  HookManager,
  MultisigCollector,
  buildFeeBumpXdr,
  WillStatus,
  SoroWillError,
  validateBeneficiaries,
  formatUSDC,
} from '@sorowill/sdk';
import { useWill, useWillsByBeneficiary, useWillsByOwner } from '@sorowill/sdk/react';

assert.strictEqual(typeof SoroWillClient, 'function', 'ESM SoroWillClient is function');
assert.strictEqual(typeof HookManager, 'function', 'ESM HookManager is function');
assert.strictEqual(typeof MultisigCollector, 'function', 'ESM MultisigCollector is function');
assert.strictEqual(typeof buildFeeBumpXdr, 'function', 'ESM buildFeeBumpXdr is function');
assert.strictEqual(typeof WillStatus, 'object', 'ESM WillStatus is object');
assert.strictEqual(typeof SoroWillError, 'function', 'ESM SoroWillError is function');
assert.strictEqual(typeof validateBeneficiaries, 'function', 'ESM validateBeneficiaries is function');
assert.strictEqual(typeof formatUSDC, 'function', 'ESM formatUSDC is function');

assert.strictEqual(typeof useWill, 'function', 'ESM useWill is function');
assert.strictEqual(typeof useWillsByBeneficiary, 'function', 'ESM useWillsByBeneficiary is function');
assert.strictEqual(typeof useWillsByOwner, 'function', 'ESM useWillsByOwner is function');

const err = new SoroWillError('ESM smoke test');
assert.ok(err instanceof Error, 'SoroWillError instance check');
const hooks = new HookManager();
assert.strictEqual(typeof hooks.runBeforeInvoke, 'function', 'HookManager method check');
console.log('ESM entry points smoke test passed.');
`;
  fs.writeFileSync(path.join(tempDir, 'test-esm.mjs'), esmScript);
  execSync('node test-esm.mjs', { cwd: tempDir, stdio: 'inherit' });

  console.log('Running CJS entry points smoke test...');
  const cjsScript = `
const assert = require('node:assert');
const {
  SoroWillClient,
  HookManager,
  MultisigCollector,
  buildFeeBumpXdr,
  WillStatus,
  SoroWillError,
  validateBeneficiaries,
  formatUSDC,
} = require('@sorowill/sdk');
const { useWill, useWillsByBeneficiary, useWillsByOwner } = require('@sorowill/sdk/react');

assert.strictEqual(typeof SoroWillClient, 'function', 'CJS SoroWillClient is function');
assert.strictEqual(typeof HookManager, 'function', 'CJS HookManager is function');
assert.strictEqual(typeof MultisigCollector, 'function', 'CJS MultisigCollector is function');
assert.strictEqual(typeof buildFeeBumpXdr, 'function', 'CJS buildFeeBumpXdr is function');
assert.strictEqual(typeof WillStatus, 'object', 'CJS WillStatus is object');
assert.strictEqual(typeof SoroWillError, 'function', 'CJS SoroWillError is function');
assert.strictEqual(typeof validateBeneficiaries, 'function', 'CJS validateBeneficiaries is function');
assert.strictEqual(typeof formatUSDC, 'function', 'CJS formatUSDC is function');

assert.strictEqual(typeof useWill, 'function', 'CJS useWill is function');
assert.strictEqual(typeof useWillsByBeneficiary, 'function', 'CJS useWillsByBeneficiary is function');
assert.strictEqual(typeof useWillsByOwner, 'function', 'CJS useWillsByOwner is function');

const err = new SoroWillError('CJS smoke test');
assert.ok(err instanceof Error, 'CJS SoroWillError instance check');
const hooks = new HookManager();
assert.strictEqual(typeof hooks.runBeforeInvoke, 'function', 'HookManager method check');
console.log('CJS entry points smoke test passed.');
`;
  fs.writeFileSync(path.join(tempDir, 'test-cjs.cjs'), cjsScript);
  execSync('node test-cjs.cjs', { cwd: tempDir, stdio: 'inherit' });

  console.log('Running browser bundler smoke test for the react subpath...');
  const browserScript = `
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const reactEntry = fileURLToPath(import.meta.resolve('@sorowill/sdk/react'));
const source = fs.readFileSync(reactEntry, 'utf-8');

assert.ok(
  !source.includes('node:module'),
  'react subpath must not reference node:module (breaks browser bundlers)',
);
assert.ok(
  !source.includes('createRequire'),
  'react subpath must not use createRequire (Node-only API)',
);
assert.ok(
  !source.includes('import.meta.url'),
  'react subpath must not rely on import.meta.url (unavailable in CJS output)',
);

const reactDir = path.dirname(reactEntry);
const reactFiles = fs.readdirSync(reactDir).filter((f) => /\.(m?js|cjs)$/.test(f));
for (const file of reactFiles) {
  const contents = fs.readFileSync(path.join(reactDir, file), 'utf-8');
  assert.ok(
    !contents.includes('node:module') && !contents.includes('createRequire'),
    \`react subpath file \${file} must be free of Node-only module loading\`,
  );
}
console.log('Browser bundler smoke test passed.');
`;
  fs.writeFileSync(path.join(tempDir, 'test-browser.mjs'), browserScript);
  execSync('node test-browser.mjs', { cwd: tempDir, stdio: 'inherit' });

  console.log('All smoke tests passed successfully!');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (fs.existsSync(tarballPath)) {
    fs.unlinkSync(tarballPath);
  }
}
