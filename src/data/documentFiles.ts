/**
 * Uploaded licence and insurance files (company_document_files).
 *
 * The list of documents travels with the rest of the company data; the
 * files themselves do not (up to 5 MB each), so they are uploaded here
 * straight away and read back only when someone opens one. Shown in the
 * app from a blob: address (the Content-Security-Policy allows blob:
 * images; PDFs open in a new tab or download).
 *
 * In demo mode (no Supabase configured) files are kept in memory until
 * the page is reloaded.
 */
import { supabase } from "./supabaseClient";
import { supabaseConfig } from "../config";
import {
  MAX_FILE_BYTES,
  base64ToBytes,
  bytesToBase64,
  cleanFileName,
  formatBytes,
  sniffType,
  uploadKind,
  uploadProblem,
  type StoredFileType,
} from "../companyDocuments";
import { uid } from "../utils";

export interface PreparedFile {
  bytes: Uint8Array;
  type: StoredFileType;
  name: string;
}

export class UploadError extends Error {}

const demoFiles = new Map<string, { type: StoredFileType; bytes: Uint8Array; name: string }>();

/**
 * Draw a photo onto a canvas and save it as a JPG small enough to store
 * (at most maxBytes, longest side at most maxSide pixels). Also used for
 * equipment problem photos (src/data/problemPhotos.ts).
 */
export async function photoToJpeg(
  file: Blob,
  maxBytes: number = MAX_FILE_BYTES,
  maxSide = 3000,
): Promise<Uint8Array> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    let scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight, 1));
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const g = canvas.getContext("2d");
      if (!g) break;
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85),
      );
      if (blob && blob.size <= maxBytes) return new Uint8Array(await blob.arrayBuffer());
      scale *= 0.75;
    }
  } catch {
    // Falls through to the error below.
  } finally {
    URL.revokeObjectURL(url);
  }
  throw new UploadError(
    "This browser could not read that photo. Save it as a JPG or PNG (or take a screenshot of it) and try again.",
  );
}

/**
 * Check a chosen file and turn it into what is stored: PDFs as they
 * are; JPG/PNG as they are when under 5 MB, else made smaller as a
 * JPG; iPhone HEIC photos converted to JPG (works where the browser
 * can show HEIC, e.g. Safari; elsewhere it asks for a JPG).
 */
export async function prepareUpload(file: File): Promise<PreparedFile> {
  const problem = uploadProblem(file);
  if (problem) throw new UploadError(problem);
  const kind = uploadKind(file);
  if (kind === "application/pdf") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sniffType(bytes) !== "application/pdf") {
      throw new UploadError("That file does not look like a PDF.");
    }
    return { bytes, type: "application/pdf", name: cleanFileName(file.name, "application/pdf") };
  }
  if (kind === "image/jpeg" || kind === "image/png") {
    if (file.size <= MAX_FILE_BYTES) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sniffed = sniffType(bytes);
      if (sniffed === "image/jpeg" || sniffed === "image/png") {
        return { bytes, type: sniffed, name: cleanFileName(file.name, sniffed) };
      }
    }
  }
  // HEIC, a photo over 5 MB, or a photo whose bytes are not what its
  // name says: redraw it as a JPG.
  const bytes = await photoToJpeg(file);
  return { bytes, type: "image/jpeg", name: cleanFileName(file.name, "image/jpeg") };
}

/** Upload a prepared file. Returns the new file id. */
export async function uploadDocumentFile(f: PreparedFile): Promise<string> {
  if (f.bytes.length > MAX_FILE_BYTES) {
    throw new UploadError(`That file is ${formatBytes(f.bytes.length)}; the limit is 5 MB.`);
  }
  const id = uid();
  if (!supabase) {
    demoFiles.set(id, { type: f.type, bytes: f.bytes, name: f.name });
    return id;
  }
  const { error } = await supabase.from("company_document_files").insert({
    id,
    company_id: supabaseConfig.companyId,
    file_name: f.name,
    mime_type: f.type,
    size_bytes: f.bytes.length,
    data_base64: bytesToBase64(f.bytes),
  });
  if (error) {
    throw new UploadError(
      error.code === "42501"
        ? "Your login isn't allowed to upload documents."
        : /abort/i.test(error.message)
          ? "The upload took too long. Check the connection and try again."
          : `Could not upload the file: ${error.message}`,
    );
  }
  return id;
}

/** Delete an uploaded file no document points at (an abandoned upload). */
export async function discardDocumentFile(id: string): Promise<void> {
  if (!supabase) {
    demoFiles.delete(id);
    return;
  }
  await supabase
    .from("company_document_files")
    .delete()
    .eq("company_id", supabaseConfig.companyId)
    .eq("id", id);
}

/** Read one uploaded file back, as a Blob of its type. */
export async function loadDocumentFile(id: string): Promise<Blob> {
  if (!supabase) {
    const f = demoFiles.get(id);
    if (!f) throw new UploadError("Demo mode keeps files only until the page is reloaded.");
    return new Blob([f.bytes as BlobPart], { type: f.type });
  }
  const { data, error } = await supabase
    .from("company_document_files")
    .select("mime_type,data_base64")
    .eq("company_id", supabaseConfig.companyId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new UploadError(`Could not open the file: ${error.message}`);
  if (!data) throw new UploadError("That file is no longer there.");
  const row = data as { mime_type: string; data_base64: string };
  return new Blob([base64ToBytes(row.data_base64) as BlobPart], { type: row.mime_type });
}
