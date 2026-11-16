/**
 * Licences & insurance (owners, managers and the office). One list of
 * the business's and the team's licences, certificates and insurance
 * policies, each with its expiry status and the uploaded PDF or photo.
 *
 * The list comes with the company data (company_documents); a file is
 * read from the database only when someone opens it
 * (src/data/documentFiles.ts) and shown from a blob: address. The
 * Dashboard reminds the office 30 days before anything expires.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLoadedState, useStore } from "../store";
import type { CompanyDocument, CompanyDocumentKind } from "../types";
import {
  DOCUMENT_KINDS,
  documentHolder,
  documentKindLabel,
  documentStatus,
  documentStatusLabel,
  isRenewed,
  sortDocuments,
  type DocumentStatus,
} from "../companyDocuments";
import {
  UploadError,
  discardDocumentFile,
  loadDocumentFile,
  prepareUpload,
  uploadDocumentFile,
} from "../data/documentFiles";
import { fmtDate, todayStr, uid } from "../utils";
import { dangerBtn, inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";

const ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic,image/heif";

function chipCls(s: DocumentStatus): string {
  switch (s.kind) {
    case "valid":
      return "bg-emerald-100 text-emerald-800";
    case "expiring":
      return "bg-amber-100 text-amber-800";
    case "expired":
      return "bg-red-100 text-red-800";
    case "no-expiry":
      return "bg-slate-100 text-slate-600";
  }
}

export function DocumentStatusChip({ status }: { status: DocumentStatus }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${chipCls(status)}`}>
      {documentStatusLabel(status)}
    </span>
  );
}

function errorText(e: unknown): string {
  if (e instanceof UploadError) return e.message;
  return "Something went wrong. Check the connection and try again.";
}

function DocumentForm({
  existing,
  onDone,
}: {
  existing: CompanyDocument | null;
  onDone: () => void;
}) {
  const { saveCompanyDocument } = useStore();
  const state = useLoadedState();
  const [kind, setKind] = useState<CompanyDocumentKind>(existing?.kind ?? "liability_insurance");
  const [name, setName] = useState(existing?.name ?? "");
  const [crewId, setCrewId] = useState(existing?.crewId ?? "");
  const [issuer, setIssuer] = useState(existing?.issuer ?? "");
  const [startDate, setStartDate] = useState(existing?.startDate ?? "");
  const [expiryDate, setExpiryDate] = useState(existing?.expiryDate ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = state.crew
    .filter((c) => c.status !== "pending" && (c.status === "active" || c.id === existing?.crewId))
    .sort((a, b) => a.name.localeCompare(b.name));

  const save = async () => {
    setError(null);
    if (startDate && expiryDate && expiryDate < startDate) {
      setError("The expiry date is before the start date.");
      return;
    }
    let fileId = existing?.fileId ?? null;
    let fileName = existing?.fileName ?? "";
    let uploaded: string | null = null;
    if (file) {
      setBusy(true);
      try {
        const prepared = await prepareUpload(file);
        uploaded = await uploadDocumentFile(prepared);
        fileId = uploaded;
        fileName = prepared.name;
      } catch (e) {
        setBusy(false);
        setError(errorText(e));
        return;
      }
      setBusy(false);
    }
    try {
      saveCompanyDocument({
        id: existing?.id ?? uid(),
        kind,
        name: name.trim().slice(0, 200),
        crewId: crewId || null,
        issuer: issuer.trim().slice(0, 200),
        startDate: startDate || null,
        expiryDate: expiryDate || null,
        notes: notes.trim().slice(0, 4000),
        fileId,
        fileName,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      });
    } catch (e) {
      if (uploaded) void discardDocumentFile(uploaded);
      setError(errorText(e));
      return;
    }
    onDone();
  };

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-bold text-slate-900">
        {existing ? "Edit document" : "Add a licence or insurance document"}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls()} htmlFor="doc-kind">Kind</label>
          <select
            id="doc-kind"
            className={inputCls()}
            value={kind}
            onChange={(e) => setKind(e.target.value as CompanyDocumentKind)}
          >
            {DOCUMENT_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls()} htmlFor="doc-name">Name or number</label>
          <input
            id="doc-name"
            className={inputCls()}
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Policy GL-12345"
          />
        </div>
        <div>
          <label className={labelCls()} htmlFor="doc-for">Who it&apos;s for</label>
          <select id="doc-for" className={inputCls()} value={crewId} onChange={(e) => setCrewId(e.target.value)}>
            <option value="">The business</option>
            {people.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls()} htmlFor="doc-issuer">Issuer</label>
          <input
            id="doc-issuer"
            className={inputCls()}
            value={issuer}
            maxLength={200}
            onChange={(e) => setIssuer(e.target.value)}
            placeholder="Insurance company, city, ISA…"
          />
        </div>
        <div>
          <label className={labelCls()} htmlFor="doc-start">Start date</label>
          <input
            id="doc-start"
            type="date"
            className={inputCls()}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls()} htmlFor="doc-expiry">Expiry date</label>
          <input
            id="doc-expiry"
            type="date"
            className={inputCls()}
            value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()} htmlFor="doc-notes">Notes</label>
          <textarea
            id="doc-notes"
            className={inputCls()}
            rows={2}
            maxLength={4000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()} htmlFor="doc-file">
            {existing?.fileId ? "Replace the file (optional)" : "Upload the document (optional)"}
          </label>
          {existing?.fileId && !file && (
            <p className="mb-1 text-sm text-slate-600">📎 Current file: {existing.fileName || "file"}</p>
          )}
          <input
            id="doc-file"
            type="file"
            accept={ACCEPT}
            className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-semibold"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p className="mt-1 text-xs text-slate-500">
            A PDF or a photo (JPG, PNG or iPhone photo), up to 5 MB. Big photos are made smaller
            before upload.
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button className={primaryBtn()} onClick={() => void save()} disabled={busy}>
          {busy ? "Uploading…" : existing ? "Save changes" : "Add document"}
        </button>
        <button className={secondaryBtn()} onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}

interface OpenFile {
  docId: string;
  url: string;
  type: string;
  name: string;
}

function FileViewer({ file, onClose }: { file: OpenFile; onClose: () => void }) {
  const isImage = file.type.startsWith("image/");
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      {isImage ? (
        <img src={file.url} alt={file.name} className="max-h-[70vh] w-auto max-w-full rounded border border-slate-200 bg-white" />
      ) : (
        <p className="text-sm text-slate-700">📄 {file.name}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {!isImage && (
          <a className={primaryBtn()} href={file.url} target="_blank" rel="noopener noreferrer">
            Open PDF
          </a>
        )}
        <a className={secondaryBtn()} href={file.url} download={file.name}>
          Download
        </a>
        <button className={secondaryBtn()} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export default function LicencesInsurance() {
  const { canEdit, deleteCompanyDocument } = useStore();
  const state = useLoadedState();
  const today = todayStr();
  const [editing, setEditing] = useState<CompanyDocument | "new" | null>(null);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [fileError, setFileError] = useState<{ docId: string; text: string } | null>(null);
  const openRef = useRef<OpenFile | null>(null);
  const docs = useMemo(
    () => sortDocuments(state.companyDocuments ?? [], today),
    [state.companyDocuments, today],
  );

  const closeFile = () => {
    if (openRef.current) URL.revokeObjectURL(openRef.current.url);
    openRef.current = null;
    setOpen(null);
  };
  // Free the file's memory when leaving the screen.
  useEffect(
    () => () => {
      if (openRef.current) URL.revokeObjectURL(openRef.current.url);
    },
    [],
  );

  const viewFile = async (d: CompanyDocument) => {
    if (!d.fileId) return;
    closeFile();
    setFileError(null);
    setLoadingId(d.id);
    try {
      const blob = await loadDocumentFile(d.fileId);
      const f: OpenFile = {
        docId: d.id,
        url: URL.createObjectURL(blob),
        type: blob.type,
        name: d.fileName || "document",
      };
      openRef.current = f;
      setOpen(f);
    } catch (e) {
      setFileError({ docId: d.id, text: errorText(e) });
    } finally {
      setLoadingId(null);
    }
  };

  if (!canEdit) {
    return (
      <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        Licences and insurance are kept by the office.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Licences &amp; insurance</h1>
          <p className="text-sm text-slate-500">
            The business&apos;s and the team&apos;s licences, certificates and insurance, with the
            uploaded copy. Only owners, managers and the office can see this.
          </p>
        </div>
        {editing === null && (
          <button className={`${primaryBtn()} min-h-11`} onClick={() => setEditing("new")}>
            + Add document
          </button>
        )}
      </div>

      {editing !== null && (
        <DocumentForm
          key={editing === "new" ? "new" : editing.id}
          existing={editing === "new" ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}

      {docs.length === 0 && editing === null && (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">
          No documents yet. Add the business licence, insurance certificates and the team&apos;s
          certifications, with a PDF or photo of each.
        </p>
      )}

      <ul className="space-y-3">
        {docs.map((d) => {
          const status = documentStatus(d, today);
          return (
            <li key={d.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {documentKindLabel(d.kind)}
                  </p>
                  <p className="break-words text-base font-bold text-slate-900">
                    {d.name || documentKindLabel(d.kind)}
                  </p>
                  <p className="text-sm text-slate-600">
                    For: {documentHolder(d, state.crew)}
                    {d.issuer ? ` · Issued by ${d.issuer}` : ""}
                  </p>
                  <p className="text-sm text-slate-600">
                    {d.startDate ? `From ${fmtDate(d.startDate)} ${d.startDate.slice(0, 4)}` : ""}
                    {d.startDate && d.expiryDate ? " · " : ""}
                    {d.expiryDate ? `Expires ${fmtDate(d.expiryDate)} ${d.expiryDate.slice(0, 4)}` : ""}
                  </p>
                  {d.notes && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{d.notes}</p>}
                </div>
                <div className="text-right">
                  <DocumentStatusChip status={status} />
                  {isRenewed(d, state.companyDocuments, today) && (
                    <p className="mt-1 text-xs text-slate-500">Renewed, no reminder</p>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {d.fileId ? (
                  <button
                    className={secondaryBtn()}
                    onClick={() => (open?.docId === d.id ? closeFile() : void viewFile(d))}
                    disabled={loadingId === d.id}
                  >
                    {loadingId === d.id ? "Opening…" : open?.docId === d.id ? "Hide file" : `📎 View ${d.fileName || "file"}`}
                  </button>
                ) : (
                  <span className="self-center text-sm text-slate-500">No file uploaded</span>
                )}
                <button className={secondaryBtn()} onClick={() => setEditing(d)}>
                  Edit
                </button>
                <button
                  className={dangerBtn()}
                  onClick={() => {
                    if (!window.confirm(`Delete "${d.name || documentKindLabel(d.kind)}" and its file?`)) return;
                    if (open?.docId === d.id) closeFile();
                    if (editing !== null && editing !== "new" && editing.id === d.id) setEditing(null);
                    deleteCompanyDocument(d.id);
                  }}
                >
                  Delete
                </button>
              </div>
              {fileError?.docId === d.id && (
                <p role="alert" className="mt-2 text-sm font-semibold text-red-700">
                  {fileError.text}
                </p>
              )}
              {open?.docId === d.id && <FileViewer file={open} onClose={closeFile} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
