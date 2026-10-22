/** Public form metadata; credentials and provider clients stay on the server. */
export const CONNECTION_FORMS = [
  { platform: 'bluesky', label: 'Bluesky', help: 'Foloseste contul existent si o parola de aplicatie creata in Bluesky > Settings > App passwords.', fields: [
    { key: 'identifier', label: 'Utilizator sau email', secret: false },
    { key: 'password', label: 'Parola de aplicatie', secret: true },
  ], instance: true, destination: false },
  { platform: 'devto', label: 'dev.to', help: 'Copiaza cheia API din contul existent: dev.to > Settings > Extensions > DEV Community API Keys.', fields: [
    { key: 'apiKey', label: 'Cheie API', secret: true },
  ], instance: false, destination: false },
  { platform: 'telegram', label: 'Telegram', help: 'Adauga botul ca administrator al canalului existent, cu permisiunea de a publica. Introdu tokenul de la BotFather si canalul.', fields: [
    { key: 'botToken', label: 'Token bot', secret: true },
  ], instance: false, destination: true },
] as const

export type CredentialPlatform = typeof CONNECTION_FORMS[number]['platform']
