import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { LimitAction, ModelTier, Settings as SettingsT } from "@website-chatbot/shared";
import type { Overview } from "./api";
import { Badge, Button, Card, Toggle } from "./ui";

const ACTIONS: { id: LimitAction; label: string }[] = [
  { id: "free_tier", label: "Switch to the free models" },
  { id: "get_in_touch", label: "Show Get in touch" },
];

export function Settings({ overview, onSave }: { overview: Overview; onSave: (p: Partial<SettingsT>) => Promise<void> }) {
  const [draft, setDraft] = useState<SettingsT>(overview.settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft(overview.settings);
  }, [overview.settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(overview.settings);
  const set = <K extends keyof SettingsT>(k: K, v: SettingsT[K]) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const setTier = (i: number, p: Partial<ModelTier>) => set("ladder", draft.ladder.map((t, j) => (j === i ? { ...t, ...p } : t)));
  const move = (i: number, by: number) => {
    const l = [...draft.ladder];
    const [t] = l.splice(i, 1);
    l.splice(i + by, 0, t!);
    set("ladder", l);
  };
  const cooling = new Map(overview.modelHealth.filter((h) => (h.cooldown_until ?? 0) > Date.now()).map((h) => [h.model, h.cooldown_until!]));

  const save = async () => {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
    setSaved(true);
  };

  return (
    <div className="h-full overflow-y-auto p-4 pb-24">
      <div className="mx-auto max-w-3xl space-y-4">
        <Card title="Model ladder" actions={<span className="text-xs text-muted-fg">Tried top to bottom</span>}>
          <ol className="space-y-2">
            {draft.ladder.map((t, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                <span className="w-5 text-center text-xs text-muted-fg tabular">{i + 1}</span>
                <input aria-label="Label" value={t.label} onChange={(e) => setTier(i, { label: e.target.value })} className="w-40 rounded border border-border bg-panel px-2 py-1 text-sm" />
                <input aria-label="Model" value={t.model} onChange={(e) => setTier(i, { model: e.target.value })} className="min-w-0 flex-1 rounded border border-border bg-panel px-2 py-1 font-mono text-xs" />
                <input aria-label="Provider" value={t.provider} onChange={(e) => setTier(i, { provider: e.target.value })} className="w-36 rounded border border-border bg-panel px-2 py-1 font-mono text-xs" title="Omnara provider config name" />
                <select aria-label="Effort" value={t.effort ?? "high"} onChange={(e) => setTier(i, { effort: e.target.value })} className="rounded border border-border bg-panel px-2 py-1 text-xs" title="Reasoning effort">
                  <option value="high">Effort: high</option>
                  <option value="medium">Effort: medium</option>
                  <option value="low">Effort: low</option>
                  <option value="none">Effort: none</option>
                  <option value="">Effort: model default</option>
                </select>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={t.free} onChange={(e) => setTier(i, { free: e.target.checked })} /> Free
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={t.enabled} onChange={(e) => setTier(i, { enabled: e.target.checked })} /> On
                </label>
                {cooling.has(t.model) && <Badge tone="warn">Skipped for {Math.ceil((cooling.get(t.model)! - Date.now()) / 60_000)} more min</Badge>}
                <span className="ml-auto flex">
                  <Button variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp size={14} />
                  </Button>
                  <Button variant="ghost" aria-label="Move down" disabled={i === draft.ladder.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown size={14} />
                  </Button>
                  <Button variant="ghost" aria-label={`Remove ${t.label}`} onClick={() => set("ladder", draft.ladder.filter((_, j) => j !== i))}>
                    <Trash2 size={14} />
                  </Button>
                </span>
              </li>
            ))}
          </ol>
          <Button className="mt-3" onClick={() => set("ladder", [...draft.ladder, { provider: "omnara-openrouter", model: "", label: "New model", free: false, enabled: false, effort: "high" }])}>
            <Plus size={14} /> Add model
          </Button>
          <p className="mt-3 text-xs text-muted-fg">
            A model that fails {draft.cooldownAfterFailures} times within an hour is skipped for {draft.cooldownMinutes} minutes. Free models need a provider with your own OpenRouter key on Omnara.
          </p>
        </Card>

        <Card title="Spending">
          <div className="grid gap-4 sm:grid-cols-2">
            <Num label="Limit per chat (USD)" value={draft.chatCapUsd} step={0.05} onChange={(v) => set("chatCapUsd", v)} />
            <Choice label="When a chat reaches it" value={draft.capAction} onChange={(v) => set("capAction", v)} />
            <Num label="Limit per day, all chats (USD)" value={draft.dailyBudgetUsd} step={0.5} onChange={(v) => set("dailyBudgetUsd", v)} />
            <Choice label="When the day's limit is reached" value={draft.budgetAction} onChange={(v) => set("budgetAction", v)} />
          </div>
        </Card>

        <Card title="Limits and timing">
          <div className="grid gap-4 sm:grid-cols-2">
            <Num label="Messages per visitor per day" value={draft.perVisitorDailyMessages} onChange={(v) => set("perVisitorDailyMessages", v)} />
            <Num label="Longest visitor message (characters)" value={draft.maxMessageChars} step={100} onChange={(v) => set("maxMessageChars", v)} />
            <Num label="Try the next model after this much total silence (seconds)" value={draft.stallTimeoutSec} onChange={(v) => set("stallTimeoutSec", v)} />
            <Num label="Longest one model may take on an answer (seconds)" value={draft.modelTimeoutSec} onChange={(v) => set("modelTimeoutSec", v)} />
            <Num label="Longest a visitor waits for an answer, all models included (seconds)" value={draft.turnTimeoutSec} onChange={(v) => set("turnTimeoutSec", v)} />
            <Num label={'Show "Still working on it" when no words after (seconds)'} value={draft.stillWorkingSec} onChange={(v) => set("stillWorkingSec", v)} />
            <Num label="Status Auto: show me as away after this many idle minutes" value={draft.awayAfterMin} onChange={(v) => set("awayAfterMin", v)} />
            <Num label="Failures before a cooldown" value={draft.cooldownAfterFailures} onChange={(v) => set("cooldownAfterFailures", v)} />
            <Num label="Cooldown length (minutes)" value={draft.cooldownMinutes} onChange={(v) => set("cooldownMinutes", v)} />
            <Num label="Archive idle chats on Omnara after (days)" value={draft.archiveAfterDays} onChange={(v) => set("archiveAfterDays", v)} />
          </div>
        </Card>

        <Card title="Behaviour">
          <Toggle label="Stream answers word by word" hint="Off: each answer appears when it's finished. A chat whose answer was cut off stops streaming on its own." checked={draft.streaming} onChange={(v) => set("streaming", v)} />
          <Num label="Send streamed words in batches every (ms, 0 = each piece at once)" value={draft.deltaBatchMs} step={10} onChange={(v) => set("deltaBatchMs", v)} />
          <Toggle label="Alert me about every new chat" hint="Off: alerts only for messages and requests for you" checked={draft.alertOnNewChat} onChange={(v) => set("alertOnNewChat", v)} />
        </Card>
      </div>

      <div className="fixed inset-x-0 bottom-0 flex items-center justify-end gap-3 border-t border-border bg-panel px-4 py-3 md:left-56">
        {saved && !dirty && <span className="text-sm text-ok">Settings saved</span>}
        <Button disabled={!dirty || saving} onClick={() => setDraft(overview.settings)}>
          Discard changes
        </Button>
        <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}

function Num({ label, value, step = 1, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input type="number" min={0} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="rounded-md border border-border bg-panel px-2 py-1.5 tabular" />
    </label>
  );
}

function Choice({ label, value, onChange }: { label: string; value: LimitAction; onChange: (v: LimitAction) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as LimitAction)} className="rounded-md border border-border bg-panel px-2 py-1.5">
        {ACTIONS.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  );
}
