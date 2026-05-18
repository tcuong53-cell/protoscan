/**
 * Shared pattern for frames/sections that are NOT prototype screens.
 * Applied at both page level (filterPages) and frame/section level (collectScreens).
 */
export const NON_PROTOTYPE_PATTERN =
  /\b(foundations?|components?|archive|roadmap|changelog|tokens?|icons?|assets?|styleguide|style\.guide|templates?|gradient|ds[.\s_-]?overview|inspecci[oó]n|annotations?|long|touch[.\s_-]?targets?|wip|specs?|ejemplo)\b/i;

export function isNonPrototypeFrame(name: string): boolean {
  return NON_PROTOTYPE_PATTERN.test(name);
}

/**
 * Pattern for orphan screens that are likely state variants, not prototype flow issues.
 * Used to downgrade orphan confidence to 'low' instead of flagging as actionable issues.
 */
export const STATE_VARIANT_PATTERN =
  /\b(errores?|error|skeleton|loading|empty)\b|[-—]\s*(android|ios)\b|\bkeyboard\s*visible\b|\((saved\s|skeleton|loading|submitting|errores?|error)\b/i;

/** Pattern for detecting tab-bar root screens (BottomNav child component name) */
export const TAB_ROOT_CHILD_PATTERN = /bottom[.\s_-]?nav|tab[.\s_-]?bar|nav[.\s_-]?bar/i;
