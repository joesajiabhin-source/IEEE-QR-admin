import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],publicDir:'assets',build:{outDir:'public',emptyOutDir:true},server:{proxy:{'/api':'http://localhost:3001'}}});
