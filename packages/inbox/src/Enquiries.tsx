import { useEffect, useState } from "react";
import type { Enquiry } from "@website-chatbot/shared";
import { ago, api } from "./api";
import { Badge, Empty, ErrorLine } from "./ui";

const STATUS: { id: Enquiry["status"]; label: string }[] = [
  { id: "new", label: "New" },
  { id: "replied", label: "Replied" },
  { id: "closed", label: "Closed" },
];

export function Enquiries({ tick, sites }: { tick: number; sites: { key: string; name: string }[] }) {
  const [list, setList] = useState<Enquiry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .enquiries()
      .then(setList)
      .catch((e: Error) => setError(e.message));
  }, [tick]);

  const setStatus = async (id: string, status: Enquiry["status"]) => {
    setList((l) => l?.map((e) => (e.id === id ? { ...e, status } : e)) ?? l);
    try {
      await api.enquiryStatus(id, status);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error) return <div className="p-4"><ErrorLine error={error} /></div>;
  if (!list) return <Empty>Loading messages…</Empty>;
  if (!list.length) return <Empty>No messages yet. Messages visitors leave through the chat appear here.</Empty>;

  return (
    <div className="h-full overflow-y-auto p-4">
      <ul className="mx-auto max-w-3xl space-y-3">
        {list.map((e) => (
          <li key={e.id} className="rounded-lg border border-border bg-panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{e.name || "No name"}</span>
              <a className="text-sm text-accent underline" href={`mailto:${e.email}`}>
                {e.email}
              </a>
              {sites.length > 1 && <Badge>{sites.find((s) => s.key === e.site)?.name ?? e.site}</Badge>}
              <span className="ml-auto text-xs text-muted-fg">{ago(e.createdAt)}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm">{e.message}</p>
            <div className="mt-3 flex items-center gap-3">
              <select
                aria-label="Status"
                value={e.status}
                onChange={(ev) => void setStatus(e.id, ev.target.value as Enquiry["status"])}
                className="rounded-md border border-border bg-panel px-2 py-1 text-sm"
              >
                {STATUS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <a href={`#/chats/${e.chatId}`} className="text-sm text-accent underline">
                Open the chat
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
