import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const CERTIFICATE_DIR = resolve(".acceptance-tls");
const KEY_PATH = resolve(CERTIFICATE_DIR, "localhost-key.pem");
const CERTIFICATE_PATH = resolve(CERTIFICATE_DIR, "localhost-cert.pem");

/**
 * Browsers only negotiate HTTP/2 over TLS, and the paired-device Lighthouse profile has
 * to measure the protocol production actually serves. This mints a throwaway self-signed
 * certificate for the loopback acceptance server.
 *
 * It is generated at run time and written to a git-ignored directory rather than
 * committed: a checked-in private key is a private key regardless of what it is for.
 */
export async function ensureAcceptanceCertificate() {
  await mkdir(CERTIFICATE_DIR, { recursive: true });

  const existing = await readExistingCertificate();
  if (existing) return existing;

  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    KEY_PATH,
    "-out",
    CERTIFICATE_PATH,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ]);

  const certificate = await readExistingCertificate();
  if (!certificate) throw new Error("openssl did not produce an acceptance certificate");
  return certificate;
}

async function readExistingCertificate() {
  try {
    const [key, cert] = await Promise.all([
      readFile(KEY_PATH, "utf8"),
      readFile(CERTIFICATE_PATH, "utf8"),
    ]);
    return { key, cert };
  } catch {
    return undefined;
  }
}

/**
 * Chrome refuses a self-signed certificate, and a page served over a rejected certificate
 * is not a secure context — no service worker, so no PWA to measure. Pinning this exact
 * key's SPKI digest makes Chrome trust this one certificate and nothing else, which
 * `--ignore-certificate-errors` (which disables the check wholesale, and still leaves the
 * origin marked insecure) does not.
 */
export async function certificateSpkiFingerprint() {
  await ensureAcceptanceCertificate();

  // execFileSync, not execFile: the pipeline feeds each stage on stdin, and the async
  // form has no `input` option — it would leave openssl waiting on a stdin that never
  // closes.
  const publicKey = execFileSync("openssl", ["x509", "-pubkey", "-noout", "-in", CERTIFICATE_PATH]);
  const der = execFileSync("openssl", ["pkey", "-pubin", "-outform", "der"], { input: publicKey });
  const digest = execFileSync("openssl", ["dgst", "-sha256", "-binary"], { input: der });
  return digest.toString("base64");
}

if (process.argv[2] === "--print-spki") {
  process.stdout.write(`${await certificateSpkiFingerprint()}\n`);
}

export { CERTIFICATE_DIR };
