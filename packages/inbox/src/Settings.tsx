import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LimitAction, ModelTier, Settings as SettingsT, VisitorLabel } from "@website-chatbot/shared";
import { api, type Overview } from "./api";
import { Badge, Button, Card, Toggle } from "./ui";

const ACTIONS: { id: LimitAction; label: string }[] = [
  { id: "free_tier", label: "Switch to the free models" },
  { id: "get_in_touch", label: "Show Get in touch" },
];

export function Settings({ overview, onSave }: { overview: Overview; onSave: (p: Partial<SettingsT>) => Promise<void> }) {
  const [draft, setDraft] = useState<SettingsT>(overview.settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const server = useRef(overview.settings);
  // The inbox refreshes every minute: take the server's values only while nothing is being edited.
  useEffect(() => {
    const before = JSON.stringify(server.current);
    server.current = overview.settings;
    setDraft((d) => (JSON.stringify(d) === before ? overview.settings : d));
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
        <Card title="AI answers">
          <Toggle label="AI answers visitors" hint="Off: visitors see Get in touch instead" checked={draft.aiEnabled} onChange={(v) => set("aiEnabled", v)} />
        </Card>

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
            <Num
              label="Chat messages per visitor per day"
              hint="How many times one visitor can write to the assistant in a day. After that, the chat shows your contact options."
              value={draft.perVisitorDailyMessages}
              onChange={(v) => set("perVisitorDailyMessages", v)}
            />
            <Num
              label="Messages left for you, per visitor per day"
              hint="The contact form, messages the assistant saves for you, and chats a visitor emails to themselves."
              value={draft.visitorMessagesPerDay}
              onChange={(v) => set("visitorMessagesPerDay", v)}
            />
            <Num
              label="Emails to visitors per day, all sites"
              hint="Confirmations and emailed chats. After that, messages still reach you; only the visitor's copy is skipped."
              value={draft.visitorEmailsPerDay}
              onChange={(v) => set("visitorEmailsPerDay", v)}
            />
            <Num
              label="Minutes between phone alerts for one chat"
              hint={'For "wants you" alerts and email replies from the same chat.'}
              value={draft.wantsYouAlertEveryMin}
              onChange={(v) => set("wantsYouAlertEveryMin", v)}
            />
            <Num label="Longest visitor message (characters)" value={draft.maxMessageChars} step={100} onChange={(v) => set("maxMessageChars", v)} />
            <Num label="Try the next model after this much total silence (seconds)" value={draft.stallTimeoutSec} onChange={(v) => set("stallTimeoutSec", v)} />
            <Num label="Longest one model may take on an answer (seconds)" value={draft.modelTimeoutSec} onChange={(v) => set("modelTimeoutSec", v)} />
            <Num label="Longest a visitor waits for an answer, all models included (seconds)" value={draft.turnTimeoutSec} onChange={(v) => set("turnTimeoutSec", v)} />
            <Num label={'Show "Still working on it" when no words after (seconds)'} value={draft.stillWorkingSec} onChange={(v) => set("stillWorkingSec", v)} />
            <Num label="Status Auto: show me as away after this many idle minutes" value={draft.awayAfterMin} onChange={(v) => set("awayAfterMin", v)} />
            <Num label="Hand a chat back to the AI when I haven't replied for (minutes, 0 = never)" value={draft.handBackAfterMin} onChange={(v) => set("handBackAfterMin", v)} />
            <Num label="Failures before a cooldown" value={draft.cooldownAfterFailures} onChange={(v) => set("cooldownAfterFailures", v)} />
            <Num label="Cooldown length (minutes)" value={draft.cooldownMinutes} onChange={(v) => set("cooldownMinutes", v)} />
            <Num label="Archive idle chats on Omnara after (days)" value={draft.archiveAfterDays} onChange={(v) => set("archiveAfterDays", v)} />
          </div>
        </Card>

        <Card title="Behaviour">
          <Toggle label="Stream answers word by word" hint="Off: each answer appears when it's finished. A chat whose answer was cut off stops streaming on its own." checked={draft.streaming} onChange={(v) => set("streaming", v)} />
          <Num label="Send streamed words in batches every (ms, 0 = each piece at once)" value={draft.deltaBatchMs} step={10} onChange={(v) => set("deltaBatchMs", v)} />
          <Toggle label="Alert me about every new chat" hint="Off: alerts only for messages and requests for you" checked={draft.alertOnNewChat} onChange={(v) => set("alertOnNewChat", v)} />
          <Toggle label="Hand a chat back to the AI when I'm away" hint="When the visitor writes while you show as away or Do not disturb" checked={draft.handBackWhenAway} onChange={(v) => set("handBackWhenAway", v)} />
        </Card>

        <Card title="Inbox">
          <label className="flex flex-col gap-1 text-sm">
            Name visitors who haven't given a name
            <select value={draft.visitorLabel} onChange={(e) => set("visitorLabel", e.target.value as VisitorLabel)} className="rounded-md border border-border bg-panel px-2 py-1.5">
              <option value="number">By number: Visitor #42</option>
              <option value="name">By a made-up name: Blue Otter</option>
              <option value="code">By code: Visitor 55de</option>
            </select>
          </label>
          <Toggle
            label="Count test chats in Stats and the daily summary"
            hint="Test chats come from the Playground, test scripts and the dev sites"
            checked={draft.countTestChats}
            onChange={(v) => set("countTestChats", v)}
          />
        </Card>

        <PromptViewer sites={overview.sites} />
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

/** Shows the whole prompt a site's agents get: base rules, the site's own instructions and its site map. */
function PromptViewer({ sites }: { sites: { key: string; name: string }[] }) {
  const [site, setSite] = useState(sites[0]?.key ?? "");
  const [data, setData] = useState<{ prompt: string; tokensApprox: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!data) return;
    await navigator.clipboard.writeText(data.prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.prompt(site));
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };
  return (
    <Card title="Bot prompt" actions={data && <span className="text-xs text-muted-fg tabular">About {data.tokensApprox.toLocaleString()} tokens</span>}>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Site"
          value={site}
          onChange={(e) => {
            setSite(e.target.value);
            setData(null);
          }}
          className="rounded-md border border-border bg-panel px-2 py-1.5 text-sm"
        >
          {sites.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
            </option>
          ))}
        </select>
        <Button disabled={!site || loading} onClick={() => void load()}>
          {loading ? "Loading…" : data ? "Reload prompt" : "Show prompt"}
        </Button>
        {data && <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>}
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {data && <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-3 text-xs">{data.prompt}</pre>}
    </Card>
  );
}

function Num({ label, hint, value, step = 1, onChange }: { label: string; hint?: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input type="number" min={0} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="rounded-md border border-border bg-panel px-2 py-1.5 tabular" />
      {hint && <span className="text-xs text-muted-fg">{hint}</span>}
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
