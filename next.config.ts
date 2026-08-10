import type { NextConfig } from "next"

import { parseOnsalePortlessNameV1 } from "./src/server/onsale-local-origin"

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    `${parseOnsalePortlessNameV1(process.env.ONSALE_PORTLESS_NAME)}.localhost`,
  ],
  poweredByHeader: false,
  // Figma Make imports raster assets as URL strings. Keep that contract instead
  // of applying Next's StaticImageData transform to baseline-generated modules.
  images: {
    disableStaticImages: true,
  },
}

export default nextConfig
