import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Project pages live at https://<user>.github.io/pursue-console/
export default defineConfig({
  plugins: [react()],
  base: '/pursue-console/',
})
