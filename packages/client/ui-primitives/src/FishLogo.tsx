// The shipped brand mark: one SVG file served from the web app's public root.
// It carries its own ink, so no host recolors it through `currentColor`, and it
// holds no letterforms, so the expanded sidebar, collapsed rail,
// blank-conversation hero, and official mark occupant all render this same file.

import type { IconProps } from './icons/props.ts'

/**
 * Render the shipped brand mark.
 * @param props.size - rendered width in px (default 24); height follows the
 *   asset's intrinsic ratio.
 * @param props.className - extra class for layout placement.
 * @returns the brand mark image, decorative and unnamed.
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return <img src="/logo-mark.svg" alt="" width={size} className={className} />
}
