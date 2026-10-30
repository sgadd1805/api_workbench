'use strict';
// The intercepting proxy's local certificate authority: one CA per installation (its key in a file
// readable by your user account only), and per-host leaf certificates it signs on the fly so HTTPS
// traffic can be decrypted. Nothing is added to the system trust store here: the user exports
// the CA certificate and trusts it themselves, only where they want traffic decrypted.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const forge = require('node-forge');

const CA_NAME = [{ name: 'commonName', value: 'API Workbench local proxy CA' }, { name: 'organizationName', value: 'API Workbench (this computer only)' }];
const rsaPem = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
const serial = () => '01' + crypto.randomBytes(15).toString('hex'); // positive, 16 bytes
const days = (n) => new Date(Date.now() + n * 864e5);

function createCa() {
  const { publicKey, privateKey } = rsaPem();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = serial();
  cert.validity.notBefore = days(-1); cert.validity.notAfter = days(3650);
  cert.setSubject(CA_NAME); cert.setIssuer(CA_NAME);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: privateKey };
}

// dir: where ca.crt / ca.key live. seal/unseal: optional transforms of the stored key (default: none; may
// return promises, e.g. main/vault.js). → Promise<{ certPem, keyPem, certFile, created? }>
async function loadOrCreateCa(dir, { seal = (s) => s, unseal = (s) => s, regenerate = false } = {}) {
  const certFile = path.join(dir, 'ca.crt'), keyFile = path.join(dir, 'ca.key');
  if (!regenerate && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    try { return { certPem: fs.readFileSync(certFile, 'utf8'), keyPem: await unseal(fs.readFileSync(keyFile, 'utf8')), certFile }; } catch { /* unreadable: make a new one */ }
  }
  const ca = createCa();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(certFile, ca.certPem);
  fs.writeFileSync(keyFile, await seal(ca.keyPem), { mode: 0o600 });
  return { ...ca, certFile, created: true };
}

const caInfo = (certPem) => {
  const x = new crypto.X509Certificate(certPem);
  return { subject: x.subject.replace(/\n/g, ', '), fingerprint256: x.fingerprint256, validTo: x.validTo };
};

// Signs short-lived leaf certificates for hostnames / IPs; one key pair for all leaves, cached contexts.
function leafSigner(ca) {
  const caCert = forge.pki.certificateFromPem(ca.certPem), caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const leafKeys = rsaPem();
  const leafPublic = forge.pki.publicKeyFromPem(leafKeys.publicKey);
  const contexts = new Map();
  function certFor(host) {
    const cert = forge.pki.createCertificate();
    cert.publicKey = leafPublic;
    cert.serialNumber = serial();
    cert.validity.notBefore = days(-1); cert.validity.notAfter = days(390);
    cert.setSubject([{ name: 'commonName', value: host.slice(0, 64) }]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [net.isIP(host) ? { type: 7, ip: host } : { type: 2, value: host }] },
    ]);
    cert.sign(caKey, forge.md.sha256.create());
    return forge.pki.certificateToPem(cert);
  }
  return {
    certFor,
    contextFor(host) {
      if (!contexts.has(host)) contexts.set(host, tls.createSecureContext({ key: leafKeys.privateKey, cert: certFor(host) + ca.certPem }));
      return contexts.get(host);
    },
  };
}

module.exports = { createCa, loadOrCreateCa, caInfo, leafSigner };
