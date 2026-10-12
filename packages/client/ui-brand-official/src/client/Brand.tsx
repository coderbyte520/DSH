import { FishLogo } from '@vreal/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@vreal/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@vreal/dsh-client-ui-sidebar/client'

type OfficialBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official brand mark.
 */
export function OfficialBrandMark({ size, className }: OfficialBrandMarkProps) {
  return <FishLogo size={size} className={className} />
}

/**
 * Hold the sidebar name slot with no artwork: the official mark carries the
 * whole identity, and occupying the slot keeps the shell's local-build fallback
 * label out of official builds.
 * @returns nothing.
 */
export function OfficialBrandName() {
  return null
}
