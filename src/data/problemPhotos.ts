/**
 * Equipment problem photos (equipment_problem_photos, migration
 * the "equipment problems" rules). Same approach as the licence and insurance files
 * (src/data/documentFiles.ts): the photo is redrawn as a JPG (at most
 * 1600 px, at most 2 MB), stored as base64 in its own table, and read
 * back only when someone opens it. Shown from a blob: address (the
 * Content-Security-Policy allows blob: images).
 *
 * In demo mode (no Supabase configured) photos are kept in memory until
 * the page is reloaded.
 */
import { supabase } from "./supabaseClient";
import { supabaseConfig } from "../config";
import { base64ToBytes, bytesToBase64 } from "../companyDocuments";
import { PROBLEM_PHOTO_MAX_BYTES, PROBLEM_PHOTO_MAX_SIDE } from "../equipmentProblems";
import { photoToJpeg, UploadError } from "./documentFiles";

const demoPhotos = new Map<string, Uint8Array>();

/** A chosen photo, made small enough to store (always a JPG). */
export async function preparePhoto(file: File): Promise<Uint8Array> {
  if (!file.type.startsWith("image/") && !/\.(jpe?g|png|heic|heif|webp)$/i.test(file.name)) {
    throw new UploadError("Pick a photo (JPG, PNG or an iPhone photo).");
  }
  return photoToJpeg(file, PROBLEM_PHOTO_MAX_BYTES, PROBLEM_PHOTO_MAX_SIDE);
}

/** Store the photo for a report. Returns an error line, or null. */
export async function uploadProblemPhoto(problemId: string, bytes: Uint8Array): Promise<string | null> {
  if (bytes.length > PROBLEM_PHOTO_MAX_BYTES) return "The photo is too big (2 MB at most).";
  if (!supabase) {
    demoPhotos.set(problemId, bytes);
    return null;
  }
  const { error } = await supabase.from("equipment_problem_photos").insert({
    problem_id: problemId,
    company_id: supabaseConfig.companyId,
    mime_type: "image/jpeg",
    size_bytes: bytes.length,
    data_base64: bytesToBase64(bytes),
  });
  if (!error) return null;
  return /abort/i.test(error.message)
    ? "The photo took too long to upload. Check the connection."
    : `The photo did not upload: ${error.message}`;
}

/** Read one report's photo back as a Blob. */
export async function loadProblemPhoto(problemId: string): Promise<Blob> {
  if (!supabase) {
    const b = demoPhotos.get(problemId);
    if (!b) throw new UploadError("Demo mode keeps photos only until the page is reloaded.");
    return new Blob([b as BlobPart], { type: "image/jpeg" });
  }
  const { data, error } = await supabase
    .from("equipment_problem_photos")
    .select("mime_type,data_base64")
    .eq("company_id", supabaseConfig.companyId)
    .eq("problem_id", problemId)
    .maybeSingle();
  if (error) throw new UploadError(`Could not open the photo: ${error.message}`);
  if (!data) throw new UploadError("That photo is no longer there.");
  const row = data as { mime_type: string; data_base64: string };
  return new Blob([base64ToBytes(row.data_base64) as BlobPart], { type: row.mime_type });
}
