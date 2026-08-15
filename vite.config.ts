import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * Nur BLATT-Bibliotheken in eigene Dateien trennen — solche, von denen
         * beim Start nichts anderes abhaengt.
         *
         * WICHTIG: React NICHT herausloesen. Ein Versuch damit erzeugte einen
         * Ringschluss zwischen den Teilen; die Seite blieb weiss
         * ("Cannot access 'Se' before initialization"). Vite ordnet den
         * React-Kern selbst korrekt ein.
         */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          // Freisteller-Modell: wird bewusst erst bei Bedarf nachgeladen.
          // Ein eigener Gruppenname zoege es in den Start (820 KB).
          if (id.includes('@imgly') || id.includes('onnxruntime')) return undefined;
          if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts';
          if (id.includes('firebase') || id.includes('@firebase')) return 'vendor-firebase';
          if (id.includes('@zxing') || id.includes('html5-qrcode')) return 'vendor-scanner';
          return undefined;
        },
      },
    },
    // Die Warnschwelle passt jetzt zu den getrennten Teilen.
    chunkSizeWarningLimit: 900,
  },
})
