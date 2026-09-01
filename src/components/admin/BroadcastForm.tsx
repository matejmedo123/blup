"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { sendBroadcast } from "@/app/actions/messaging";
import { Button } from "@/components/ui/Button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/Field";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

type Audience = "all" | "position" | "shift" | "custom";

const AUDIENCE_LABELS: Record<Audience, string> = {
  all: "Všetkým na evente",
  position: "Podľa pozície",
  shift: "Ľuďom na smene",
  custom: "Vybraným ľuďom",
};

export function BroadcastForm({
  positions,
  shifts,
  staff,
}: {
  positions: { id: string; name: string }[];
  shifts: { id: string; label: string }[];
  staff: { id: string; name: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [audience, setAudience] = useState<Audience>("all");
  const [positionId, setPositionId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [userIds, setUserIds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function submit() {
    setFormError(null);
    setErrors({});
    startTransition(async () => {
      const result = await sendBroadcast({
        title,
        body,
        audience,
        positionId: positionId || undefined,
        shiftId: shiftId || undefined,
        userIds: audience === "custom" ? [...userIds] : undefined,
      });
      if (result.ok) {
        toast.success(result.message ?? "Odoslané.");
        router.push(`/admin/messages/${result.data?.conversationId}`);
        router.refresh();
      } else {
        setFormError(result.message);
        setErrors(
          Object.fromEntries(Object.entries(result.fieldErrors ?? {}).map(([k, v]) => [k, v[0]])),
        );
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {formError ? <InlineNotice tone="danger">{formError}</InlineNotice> : null}

      <div>
        <p className="mb-2.5 text-sm font-semibold text-ink">Komu</p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(AUDIENCE_LABELS) as Audience[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setAudience(value)}
              aria-pressed={audience === value}
              className={cn(
                "touch cursor-pointer rounded-full px-4 text-[13px] font-semibold transition-colors",
                audience === value
                  ? "bg-ink text-white"
                  : "border border-line-strong bg-surface text-muted hover:bg-hover",
              )}
            >
              {AUDIENCE_LABELS[value]}
            </button>
          ))}
        </div>
      </div>

      {audience === "position" ? (
        <SelectField
          label="Pozícia"
          value={positionId}
          onChange={(e) => setPositionId(e.target.value)}
          error={errors.positionId}
        >
          <option value="">Vyber pozíciu…</option>
          {positions.map((position) => (
            <option key={position.id} value={position.id}>
              {position.name}
            </option>
          ))}
        </SelectField>
      ) : null}

      {audience === "shift" ? (
        <SelectField
          label="Smena"
          value={shiftId}
          onChange={(e) => setShiftId(e.target.value)}
          error={errors.shiftId}
        >
          <option value="">Vyber smenu…</option>
          {shifts.map((shift) => (
            <option key={shift.id} value={shift.id}>
              {shift.label}
            </option>
          ))}
        </SelectField>
      ) : null}

      {audience === "custom" ? (
        <div>
          <p className="mb-2 text-sm font-semibold text-ink">
            Príjemcovia ({userIds.size})
          </p>
          <div className="max-h-[280px] overflow-y-auto rounded-12 border border-line">
            <ul className="divide-y divide-divider">
              {staff.map((person) => (
                <li key={person.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 hover:bg-hover">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-ink"
                      checked={userIds.has(person.id)}
                      onChange={(e) =>
                        setUserIds((current) => {
                          const next = new Set(current);
                          if (e.target.checked) next.add(person.id);
                          else next.delete(person.id);
                          return next;
                        })
                      }
                    />
                    <span className="text-sm">{person.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <TextField
        label="Predmet"
        required
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        error={errors.title}
        placeholder="Zmena času na bare"
      />
      <TextAreaField
        label="Správa"
        required
        rows={5}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        error={errors.body}
        placeholder="Prosím všetci príďte 15 minút pred začiatkom."
      />

      <InlineNotice tone="info">
        Hromadná správa je jednosmerná — príjemcovia na ňu nemôžu odpovedať. Ak chceš diskusiu,
        použi chat k smene.
      </InlineNotice>

      <Button className="self-start" onClick={submit} loading={pending}>
        Odoslať správu
      </Button>
    </div>
  );
}
