import tailwindcss from '@tailwindcss/postcss';
import pixelFonts from './scripts/postcss-pixel-fonts.mjs';

export default {
  plugins: [tailwindcss(), pixelFonts()],
};
