import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { gzipSync } from 'zlib';

/**
 * Bundle size and tree-shaking audit for SoroWill SDK.
 *
 * This test suite validates that the compiled ESM/CJS bundles:
 * 1. Are optimized for size
 * 2. Only include necessary dependencies
 * 3. Properly tree-shake unused code
 * 4. Have sideEffects configured correctly
 *
 * Before running: npm run build
 */

interface BundleMetrics {
  path: string;
  sizeBytes: number;
  sizeKb: number;
  gzipSizeBytes?: number;
  gzipSizeKb?: number;
}

const DIST_DIR = resolve(__dirname, '../dist');
// Raised from 200 to 210 when the RPC endpoint circuit breaker
// (RpcEndpointPool quarantine/quarantined-endpoint skip logic) was added —
// CJS grew from ~194 KB to ~200.2 KB. Revisit if it approaches 210.
const MAX_BUNDLE_SIZE_KB = 210; // Threshold for maximum bundle size
const MAX_GZIP_SIZE_KB = 70; // Threshold for gzipped size

let bundleMetrics: BundleMetrics[] = [];

function getFileSize(filePath: string): BundleMetrics {
  try {
    const content = readFileSync(filePath);
    const sizeBytes = content.length;
    const sizeKb = Math.round(sizeBytes / 1024 * 100) / 100;
    const gzipSizeBytes = gzipSync(content).length;
    const gzipSizeKb = Math.round(gzipSizeBytes / 1024 * 100) / 100;

    return {
      path: filePath,
      sizeBytes,
      sizeKb,
      gzipSizeBytes,
      gzipSizeKb,
    };
  } catch (error) {
    return {
      path: filePath,
      sizeBytes: 0,
      sizeKb: 0,
    };
  }
}

describe('Bundle size and tree-shaking audit', () => {
  beforeAll(() => {
    // Collect bundle metrics
    const esmFile = resolve(DIST_DIR, 'index.js');
    const cjsFile = resolve(DIST_DIR, 'index.cjs');
    const reactEsmFile = resolve(DIST_DIR, 'react/index.js');
    const reactCjsFile = resolve(DIST_DIR, 'react/index.cjs');

    bundleMetrics = [
      getFileSize(esmFile),
      getFileSize(cjsFile),
      getFileSize(reactEsmFile),
      getFileSize(reactCjsFile),
    ].filter(m => m.sizeBytes > 0);
  });

  describe('Bundle size thresholds', () => {
    it('main ESM bundle is under size threshold', () => {
      const esmMetric = bundleMetrics.find(m => m.path.includes('index.js') && !m.path.includes('react'));
      expect(esmMetric).toBeDefined();
      if (esmMetric) {
        expect(esmMetric.sizeKb).toBeLessThan(MAX_BUNDLE_SIZE_KB);
      }
    });

    it('main CJS bundle is under size threshold', () => {
      const cjsMetric = bundleMetrics.find(m => m.path.includes('index.cjs') && !m.path.includes('react'));
      expect(cjsMetric).toBeDefined();
      if (cjsMetric) {
        expect(cjsMetric.sizeKb).toBeLessThan(MAX_BUNDLE_SIZE_KB);
      }
    });

    it('react ESM bundle is under size threshold', () => {
      const reactMetric = bundleMetrics.find(m => m.path.includes('react') && m.path.includes('index.js'));
      expect(reactMetric).toBeDefined();
      if (reactMetric) {
        expect(reactMetric.sizeKb).toBeLessThan(MAX_BUNDLE_SIZE_KB);
      }
    });

    it('react CJS bundle is under size threshold', () => {
      const reactMetric = bundleMetrics.find(m => m.path.includes('react') && m.path.includes('index.cjs'));
      expect(reactMetric).toBeDefined();
      if (reactMetric) {
        expect(reactMetric.sizeKb).toBeLessThan(MAX_BUNDLE_SIZE_KB);
      }
    });

    it('every bundle is under the gzipped size threshold', () => {
      expect(bundleMetrics.length).toBeGreaterThan(0);
      for (const metric of bundleMetrics) {
        expect(metric.gzipSizeKb).toBeDefined();
        expect(metric.gzipSizeKb as number).toBeLessThan(MAX_GZIP_SIZE_KB);
      }
    });
  });

  describe('Bundle analysis and reporting', () => {
    it('reports main bundle sizes', () => {
      const mainBundles = bundleMetrics.filter(m => !m.path.includes('react'));
      expect(mainBundles.length).toBeGreaterThan(0);

      console.log('\n=== Main Bundle Sizes ===');
      mainBundles.forEach(m => {
        const name = m.path.includes('.cjs') ? 'CJS' : 'ESM';
        console.log(`${name}: ${m.sizeKb} KB (${m.sizeBytes} bytes)`);
      });
    });

    it('reports react bundle sizes', () => {
      const reactBundles = bundleMetrics.filter(m => m.path.includes('react'));
      if (reactBundles.length > 0) {
        console.log('\n=== React Bundle Sizes ===');
        reactBundles.forEach(m => {
          const name = m.path.includes('.cjs') ? 'CJS' : 'ESM';
          console.log(`${name}: ${m.sizeKb} KB (${m.sizeBytes} bytes)`);
        });
      } else {
        console.log('\n=== React Bundle: Not found ===');
      }
    });
  });

  describe('Package.json sideEffects configuration', () => {
    it('has sideEffects explicitly set to false', () => {
      const packageJsonPath = resolve(__dirname, '../package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

      expect(packageJson.sideEffects).toBe(false);
    });

    it('exports object is properly configured for tree-shaking', () => {
      const packageJsonPath = resolve(__dirname, '../package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

      // Should have exports with both import and require
      expect(packageJson.exports).toBeDefined();
      expect(packageJson.exports['.']).toBeDefined();

      const mainExport = packageJson.exports['.'];
      expect(mainExport.import).toBeDefined();
      expect(mainExport.require).toBeDefined();
      expect(mainExport.types).toBeDefined();
    });
  });

  describe('Dependency optimization', () => {
    it('only includes necessary @stellar/stellar-sdk in bundle', () => {
      // This is a structural test - it verifies dependencies are listed
      // The actual tree-shaking is validated by bundle size thresholds above
      const packageJsonPath = resolve(__dirname, '../package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

      expect(packageJson.dependencies['@stellar/stellar-sdk']).toBeDefined();
      // Verify optional dependencies are not in main dependencies
      expect(packageJson.dependencies['react']).toBeUndefined();
      expect(packageJson.dependencies['@stellar/freighter-api']).toBeUndefined();
    });

    it('lists peerDependencies correctly', () => {
      const packageJsonPath = resolve(__dirname, '../package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

      expect(packageJson.peerDependencies).toBeDefined();
      expect(packageJson.peerDependencies.react).toBeDefined();
      expect(packageJson.peerDependencies['@stellar/freighter-api']).toBeDefined();
    });

    it('marks optional peerDependencies correctly', () => {
      const packageJsonPath = resolve(__dirname, '../package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

      expect(packageJson.peerDependenciesMeta).toBeDefined();
      expect(packageJson.peerDependenciesMeta.react.optional).toBe(true);
      expect(packageJson.peerDependenciesMeta['@stellar/freighter-api'].optional).toBe(true);
    });
  });

  describe('Build output validation', () => {
    it('generates both ESM and CJS outputs', () => {
      const esmExists = bundleMetrics.some(m => m.path.includes('index.js') && !m.path.includes('cjs'));
      const cjsExists = bundleMetrics.some(m => m.path.includes('index.cjs'));

      expect(esmExists).toBe(true);
      expect(cjsExists).toBe(true);
    });

    it('generates TypeScript definitions', () => {
      try {
        const dtsPath = resolve(DIST_DIR, 'index.d.ts');
        const content = readFileSync(dtsPath, 'utf-8');
        expect(content.length).toBeGreaterThan(0);
        expect(content).toContain('export');
      } catch {
        // If d.ts doesn't exist, fail gracefully with expectation
        expect(true).toBe(false);
      }
    });

    it('includes proper file exports in package.json', () => {
      const packageJsonPath = resolve(__dirname, '../package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

      expect(packageJson.files).toBeDefined();
      expect(packageJson.files).toContain('dist');
    });
  });

  describe('Audit recommendations', () => {
    it('provides bundle size summary for documentation', () => {
      console.log('\n=== Bundle Size Audit Summary ===');
      console.log(`Total bundles analyzed: ${bundleMetrics.length}`);
      console.log(`All bundles under ${MAX_BUNDLE_SIZE_KB}KB threshold: ${bundleMetrics.every(m => m.sizeKb < MAX_BUNDLE_SIZE_KB)}`);

      const totalSize = bundleMetrics.reduce((sum, m) => sum + m.sizeBytes, 0);
      console.log(`Total uncompressed size: ${(totalSize / 1024).toFixed(2)} KB`);

      console.log('\nConfiguration checks:');
      console.log('✓ sideEffects: false');
      console.log('✓ ESM and CJS outputs generated');
      console.log('✓ TypeScript definitions included');
      console.log('✓ Optional peerDependencies configured');
    });
  });
});

/**
 * Bundle optimization checklist:
 *
 * [✓] sideEffects set to false in package.json
 * [✓] Unused imports removed from source files
 * [✓] External dependencies marked as external in tsup config
 * [✓] Optional dependencies excluded from bundle
 * [✓] TypeScript target set for efficient output
 * [?] Minification enabled in production builds
 * [?] Dead code elimination configured
 *
 * If bundle sizes exceed thresholds:
 *
 * 1. Review tsup.config.ts for external configuration
 * 2. Check for unused imports in source files
 * 3. Verify optional dependencies are not bundled
 * 4. Use esbuild analyzer to identify large modules
 * 5. Consider code splitting for react subexport
 */
