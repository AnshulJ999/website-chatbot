import { useEffect, useMemo, useState } from "react";
import { api, usd, type Stats as StatsT } from "./api";
import { Card, Empty, ErrorLine } from "./ui";

export function Stats({ sites }: { sites: { key: string; name: string }[] }) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<StatsT | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api
      .stats(days)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [days]);

  const byDay = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, { chats: number; messages: number; enquiries: number; usd: number }>();
    const row = (d: string) => map.get(d) ?? map.set(d, { chats: 0, messages: 0, enquiries: 0, usd: 0 }).get(d)!;
    for (const c of data.chats) {
      row(c.day).chats += c.n;
      row(c.day).messages += c.messages ?? 0;
    }
    for (const e of data.enquiries) row(e.day).enquiries += e.n;
    for (const s of data.spend) row(s.day).usd += s.usd;
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v }));
  }, [data]);

  if (error) return <div className="p-4"><ErrorLine error={error} /></div>;
  if (!data) return <Empty>Loading stats…</Empty>;

  const total = byDay.reduce((t, d) => ({ chats: t.chats + d.chats, messages: t.messages + d.messages, enquiries: t.enquiries + d.enquiries, usd: t.usd + d.usd }), { chats: 0, messages: 0, enquiries: 0, usd: 0 });
  const max = Math.max(1, ...byDay.map((d) => d.chats));
  const rated = data.thumbs.up + data.thumbs.down;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Last {days} days{sites.length > 1 ? ", all sites" : ""}</h2>
          <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-md border border-border bg-panel px-2 py-1 text-sm">
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Chats", total.chats],
            ["Messages", total.messages],
            ["Left a message", total.enquiries],
            ["AI cost", usd(total.usd)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-panel p-3">
              <p className="text-xs text-muted-fg">{label}</p>
              <p className="mt-1 text-xl font-semibold tabular">{value}</p>
            </div>
          ))}
        </div>
        <Card title="Chats per day">
          {byDay.length === 0 ? (
            <p className="text-sm text-muted-fg">No chats in this period.</p>
          ) : (
            <ul className="space-y-1.5">
              {byDay.map((d) => (
                <li key={d.day} className="flex items-center gap-3 text-xs tabular">
                  <span className="w-20 shrink-0 text-muted-fg">{d.day.slice(5)}</span>
                  <span className="h-3 rounded-sm bg-accent" style={{ width: `${(d.chats / max) * 70}%`, minWidth: d.chats ? 4 : 0 }} />
                  <span>
                    {d.chats} chats · {d.enquiries} msgs · {usd(d.usd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Answer ratings">
          {rated === 0 ? (
            <p className="text-sm text-muted-fg">No ratings yet. Visitors rate answers with the thumbs under each one.</p>
          ) : (
            <p className="text-sm tabular">
              {data.thumbs.up} helpful, {data.thumbs.down} not helpful ({Math.round((data.thumbs.up / rated) * 100)}% helpful)
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
