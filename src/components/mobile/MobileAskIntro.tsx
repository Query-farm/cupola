import { ArrowUpRight, ChartNoAxesCombined, Database, Sparkles } from "lucide-react";
import { SettingsModal } from "../SettingsModal";

export function MobileAskIntro({ ready, onPrompt }: { ready: boolean; onPrompt: (prompt: string) => void }) {
  return <div className="mobile-ask-intro">
    <div className="mobile-ask-mark"><Sparkles size={24} strokeWidth={1.5} /></div>
    <h2>Start with a question.</h2>
    <p>Explore your connected data. Find a pattern, check a number, or work through an idea.</p>
    <div className="mobile-ask-suggestions">
      <button disabled={!ready} onClick={() => onPrompt("What tables and functions can I explore in this workspace?")}><Database size={18} /><span>Get to know this data</span><ArrowUpRight size={16} /></button>
      <button disabled={!ready} onClick={() => onPrompt("Help me find a useful trend in this data. Start by inspecting the available tables.")}><ChartNoAxesCombined size={18} /><span>Find a trend worth exploring</span><ArrowUpRight size={16} /></button>
    </div>
    {!ready && <div className="mobile-ai-setup"><strong>Connect your AI assistant</strong><p>Add your Anthropic API key in Settings. Your catalog, SQL, and reports are ready to use without it.</p><SettingsModal /></div>}
  </div>;
}
