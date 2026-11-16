import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

/**
 * Writes dist/precache-manifest.json: every file of this build (hashed
 * JS/CSS chunks, fonts, images). public/sw.js reads it to keep the whole
 * app on the phone, so the app opens with no signal (review,
 * #7). A new build has new names and a new `version`.
 */
export function precacheManifest(): Plugin {
  return {
    name: 'precache-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map') && f !== 'index.html')
        .sort()
      const version = files.filter((f) => f.startsWith('assets/')).join('|')
      let hash = 0
      for (let i = 0; i < version.length; i++) hash = (hash * 31 + version.charCodeAt(i)) >>> 0
      this.emitFile({
        type: 'asset',
        fileName: 'precache-manifest.json',
        source: JSON.stringify({ version: hash.toString(36), files: files.map((f) => `/${f}`) }),
      })
    },
  }
}

/**
 * This build's id: the git commit on CI, else the build time. The app
 * gets it as import.meta.env.VITE_BUILD_ID, and dist/version.json holds
 * it, so a phone or tab still running an older build notices a new
 * deploy and reloads by itself (src/buildCheck.ts).
 */
const BUILD_ID = (process.env.GITHUB_SHA || process.env.COMMIT_REF || '').slice(0, 12) || Date.now().toString(36)

export function buildVersion(id: string): Plugin {
  return {
    name: 'build-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: id }) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), precacheManifest(), buildVersion(BUILD_ID)],
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID) },
})
