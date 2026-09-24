# Processo 360 IA

Aplicação web para análise processual especializada, com leitura de PDFs extensos, divisão automática em lotes, consolidação documental e diagnóstico jurídico global.

## Arquitetura Gemini / Firebase AI Logic

A análise jurídica não depende mais de OpenAI, Cloud Functions ou Cloud Storage.

Fluxo atual:

1. o PDF permanece no navegador do usuário;
2. o navegador divide o documento em lotes usando `pdf-lib`;
3. cada lote é enviado ao Firebase AI Logic;
4. o modelo usado é `gemini-3.8-flash` pelo Gemini Developer API Free Tier;
5. cada lote concluído é salvo no `localStorage` para retomada;
6. após todos os lotes, o Gemini consolida o processo inteiro nas 7 seções do relatório.

Para PDFs grandes, a divisão considera simultaneamente páginas e tamanho do lote. O limite operacional inicial é de até 80 páginas e até 8 MB por lote.

## Por que Gemini 3.8 Flash

O projeto usa `gemini-3.8-flash` porque é o modelo Flash mais inteligente atualmente documentado pelo Google e está disponível no Free Tier. A aplicação também faz retentativas automáticas em erros transitórios de alta demanda (500/503), sem descartar os lotes já concluídos.

## Firebase

Recursos usados:

- Firebase Hosting;
- Firebase Authentication somente para a Área ADM;
- Cloud Firestore para prompts publicados;
- Firebase App Check;
- Firebase AI Logic com Gemini Developer API.

Recursos removidos do fluxo de produção:

- Cloud Functions;
- Cloud Storage;
- OpenAI API.

### Requisito para o Free Tier do Gemini

O projeto Firebase usa o plano **Blaze (pague pelo uso)** com Firebase AI Logic e Gemini Developer API. O faturamento e os limites de gasto são administrados no Firebase/Google Cloud; o aplicativo não precisa receber nenhuma chave ou sinalização adicional para saber que o projeto está no Blaze.

## Administração

O acesso administrativo continua reservado a `fernandoazeredo64@gmail.com`. O login é necessário apenas para cadastrar, editar ou excluir prompts. A análise normal de PDFs não exige login.

## Configuração local

1. Copie `.env.example` para `.env.local`.
2. Preencha as credenciais públicas do app Web do Firebase.
3. Configure o App Check com reCAPTCHA Enterprise.
4. Ative Firebase AI Logic usando Gemini Developer API.
5. Mantenha o projeto no plano Spark para o Free Tier.

```bash
npm install
npm run build
firebase deploy --only hosting,firestore:rules --project processo-360-ia
```

## Retomada

Os resultados intermediários dos lotes são gravados no navegador. Se houver limite temporário de requisições, indisponibilidade ou interrupção, o usuário pode tentar novamente depois; os lotes já concluídos serão reutilizados automaticamente quando o mesmo arquivo, área e perspectiva forem selecionados.

## Princípio de análise

Os lotes servem para extração e catalogação provisória. O diagnóstico jurídico é produzido somente após a consolidação integral do processo. Cada área e perspectiva utiliza os prompts publicados na Área ADM.

Regras centrais:

- não inventar fatos, páginas, datas, documentos, valores ou precedentes;
- usar exatamente `Informação não constante nos dados fornecidos` quando faltar dado necessário;
- classificar risco somente como `Alta`, `Média` ou `Baixa`;
- considerar todos os lotes antes da conclusão final.
