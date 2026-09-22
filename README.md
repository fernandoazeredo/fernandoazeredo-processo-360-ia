# Processo 360 IA

Aplicação web/PWA para análise processual especializada, com leitura de PDFs extensos, divisão automática em lotes, consolidação documental e diagnóstico jurídico global.

## Estado desta versão

Esta primeira versão entrega a interface responsiva, identidade visual, seleção de área e perspectiva, protetor de processamento e acesso discreto à Área ADM. O processamento jurídico e o armazenamento dos prompts serão conectados nas próximas etapas.

## Administração

O acesso administrativo é reservado a `fernandoazeredo64@gmail.com`. A senha deve ser criada no Firebase Authentication e nunca deve ser gravada no código ou no repositório.

## Configuração

1. Copie `.env.example` para `.env.local`.
2. Preencha as credenciais públicas do aplicativo Web no Firebase.
3. No Firebase Authentication, habilite **E-mail/senha**.
4. Crie o usuário administrador com o e-mail autorizado.
5. Publique as regras do Firestore e Storage.

```bash
npm install
npm run build
firebase deploy --project processo-360-ia
```

## Deploy automático

Os workflows publicam a branch `main` no Firebase Hosting e criam canais de pré-visualização para pull requests. Cadastre estes segredos no GitHub Actions:

- `FIREBASE_SERVICE_ACCOUNT_PROCESSO_360_IA` — JSON completo da conta de serviço;
- `VITE_FIREBASE_API_KEY` — chave pública do aplicativo Web;
- `VITE_FIREBASE_MESSAGING_SENDER_ID` — identificador do remetente;
- `VITE_FIREBASE_APP_ID` — identificador do aplicativo Web.

Não grave esses valores no código, no histórico do Git ou em arquivos enviados ao repositório.

## Princípio de análise

Os lotes servem apenas para extração e catalogação provisória. O diagnóstico jurídico é produzido somente após a consolidação integral do processo. Cada área e perspectiva utiliza prompts próprios, cadastrados e versionados pela Área ADM.
