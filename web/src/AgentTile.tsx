import claude from "./assets/agents/claude.svg";
import opencodeDark from "./assets/agents/opencode-dark.svg";
import opencodeLight from "./assets/agents/opencode-light.svg";
import { agentLook } from "./home.ts";

/** agents with a logo: one image, or a pair when the mark changes with the theme */
const LOGOS: Record<string, { light: string; dark?: string }> = {
  claude: { light: claude },
  opencode: { light: opencodeLight, dark: opencodeDark },
};

/**
 * The square that identifies an agent. Agents with a logo show it on a neutral tile; the rest keep
 * the design's coloured tile with an initial. `className` sets size, radius and type size.
 */
export function AgentTile({ agent, className }: { agent: string | null; className: string }) {
  const logo = agent ? LOGOS[agent] : undefined;
  const look = agentLook(agent);
  if (!logo) {
    return <span className={`flex shrink-0 items-center justify-center ${look.tile} ${className}`}>{look.initial}</span>;
  }
  const img = "h-[62%] w-[62%] object-contain";
  return (
    <span role="img" aria-label={look.label} className={`flex shrink-0 items-center justify-center border border-line bg-surface ${className}`}>
      {logo.dark ? (
        <>
          <img src={logo.light} alt="" className={`${img} dark:hidden`} />
          <img src={logo.dark} alt="" className={`${img} hidden dark:block`} />
        </>
      ) : (
        <img src={logo.light} alt="" className={img} />
      )}
    </span>
  );
}
