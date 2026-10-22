export const CREDENTIAL_PLATFORMS = ['bluesky', 'devto', 'telegram', 'medium', 'hashnode', 'slack', 'github', 'listmonk', 'stackexchange', 'farcaster', 'lemmy'] as const
export type CredentialPlatform = typeof CREDENTIAL_PLATFORMS[number]
interface ConnectionForm {
  platform: CredentialPlatform; label: string; help: string
  fields: readonly { key: string; label: string; secret: boolean; optional?: boolean }[]
  instance: boolean; destination: boolean; instanceHint?: string; destinationLabel?: string; destinationHint?: string
}
/** Public form metadata; credentials and provider clients stay on the server. */
export const CONNECTION_FORMS: readonly ConnectionForm[] = [
  { platform: 'bluesky', label: 'Bluesky', help: 'Foloseste contul existent si o parola de aplicatie creata in Bluesky > Settings > App passwords.', fields: [
    { key: 'identifier', label: 'Utilizator sau email', secret: false },
    { key: 'password', label: 'Parola de aplicatie', secret: true },
  ], instance: true, destination: false, instanceHint: 'Gol pentru bsky.social. Pentru alt server: adresa HTTPS.' },
  { platform: 'devto', label: 'dev.to', help: 'Copiaza cheia API din contul existent: dev.to > Settings > Extensions > DEV Community API Keys.', fields: [
    { key: 'apiKey', label: 'Cheie API', secret: true },
  ], instance: false, destination: false },
  { platform: 'telegram', label: 'Telegram', help: 'Adauga botul ca administrator al canalului existent, cu permisiunea de a publica. Introdu tokenul de la BotFather si canalul.', fields: [
    { key: 'botToken', label: 'Token bot', secret: true },
  ], instance: false, destination: true, destinationLabel: 'Canal sau chat', destinationHint: '@canal_exemplu sau ID-ul numeric.' },
  { platform: 'medium', label: 'Medium (token existent)', help: 'Doar pentru un token de integrare Medium deja existent si inca valid. Medium nu mai ofera suport pentru API sau integrari noi. Un cont si o parola nu activeaza API-ul.',
    fields: [{ key: 'accessToken', label: 'Token de integrare existent', secret: true }], instance: false, destination: false },
  { platform: 'hashnode', label: 'Hashnode', help: 'Token personal din setarile Hashnode si ID-ul publicatiei. API-ul de publicare necesita un plan Pro activ si rol de publicare in acea publicatie.',
    fields: [{ key: 'accessToken', label: 'Token personal Hashnode', secret: true }], instance: false, destination: true, destinationLabel: 'ID publicatie', destinationHint: 'ID-ul de 24 de caractere din setarile publicatiei.' },
  { platform: 'slack', label: 'Slack', help: 'Token al aplicatiei instalate in workspace. Necesita chat:write si acces la canal; pentru imagini, files:write. Adauga aplicatia in canal.',
    fields: [{ key: 'accessToken', label: 'Token Slack', secret: true }], instance: false, destination: true, destinationLabel: 'ID canal Slack', destinationHint: 'De forma C0123ABCD; canalul este verificat la conectare.' },
  { platform: 'github', label: 'GitHub', help: 'Token personal: Contents write pentru releases si Discussions write pentru discutii. Conectorul publica text si linkuri; atasamentele nu sunt acceptate momentan.',
    fields: [{ key: 'accessToken', label: 'Token GitHub', secret: true }], instance: false, destination: true, destinationLabel: 'Repository', destinationHint: 'owner/nume; trebuie sa ai drept de publicare.' },
  { platform: 'listmonk', label: 'Listmonk', help: 'Conecteaza lista existenta din instanta ta Listmonk. Campania este trimisa doar dupa aprobarea si programarea continutului.',
    fields: [{ key: 'username', label: 'Utilizator API', secret: false }, { key: 'apiToken', label: 'Token API', secret: true }, { key: 'fromEmail', label: 'Email expeditor', secret: false }],
    instance: true, instanceHint: 'Adresa HTTPS publica a instantei Listmonk.', destination: true, destinationLabel: 'ID lista abonati', destinationHint: 'ID numeric din Listmonk.' },
  { platform: 'stackexchange', label: 'Stack Exchange', help: 'Token OAuth cu write_access si cheia aplicatiei Stack Apps. Conectorul publica intrebari si raspunsuri fara atasamente. Platforma poate cere verificari suplimentare; regulile comunitatii raman valabile.',
    fields: [{ key: 'accessToken', label: 'Token cu write_access', secret: true }, { key: 'apiKey', label: 'Cheie aplicatie Stack Apps', secret: true }], instance: false, destination: true, destinationLabel: 'Site Stack Exchange', destinationHint: 'De exemplu money.stackexchange.com sau stackoverflow.com.' },
  { platform: 'farcaster', label: 'Farcaster', help: 'Cheie API Neynar si un signer deja aprobat de contul existent pentru publicare. Conectorul publica momentan text, fara atasamente.',
    fields: [{ key: 'apiKey', label: 'Cheie API Neynar', secret: true }, { key: 'signerUuid', label: 'UUID signer aprobat', secret: true }], instance: false, destination: false },
  { platform: 'lemmy', label: 'Lemmy', help: 'Autentificare la instanta contului existent si alegerea comunitatii. Se pastreaza doar tokenul sesiunii. API v3 si v4; postari cu text si link, fara atasamente.',
    fields: [{ key: 'username', label: 'Utilizator sau email', secret: false }, { key: 'password', label: 'Parola contului Lemmy', secret: true }, { key: 'totp', label: 'Cod TOTP (daca este activ)', secret: true, optional: true }],
    instance: true, instanceHint: 'Adresa HTTPS a instantei la care ai contul.', destination: true, destinationLabel: 'ID comunitate', destinationHint: 'ID numeric al comunitatii pe instanta ta.' },
]
