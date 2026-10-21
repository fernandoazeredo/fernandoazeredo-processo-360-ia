// Perguntas frequentes aprovadas para o menu DICAS. Conteúdo estático, sem chamadas de IA.
export const dicasFaqGroups: { title: string; items: { question: string; answer: string }[] }[] = [
  {
    "title": "Uso do aplicativo",
    "items": [
      {
        "question": "Como faço para analisar um processo judicial em PDF?",
        "answer": "Entre na sua conta e confira o saldo. Envie o PDF do processo, escolha a área jurídica e a perspectiva (a parte que você representa). Confira o preço exibido, confirme e aguarde a análise sem fechar a página."
      },
      {
        "question": "Quais áreas jurídicas estão disponíveis?",
        "answer": "Trabalhista, Cível, Criminal, Ambiental, Tributário, Administrativo, Previdenciário, Consumidor, Família e Empresarial."
      },
      {
        "question": "O que significa escolher a perspectiva?",
        "answer": "É indicar qual parte você representa no processo (por exemplo, Autor ou Réu; Reclamante ou Reclamada). A análise e a estratégia são orientadas por essa escolha."
      },
      {
        "question": "O sistema analisa processos com muitas páginas?",
        "answer": "Sim. O PDF é dividido automaticamente em lotes e, ao final, o sistema consolida tudo em um único relatório. Processos extensos podem levar vários minutos. O PDF precisa ter texto legível."
      },
      {
        "question": "Como gero uma contestação ou outra peça jurídica?",
        "answer": "Depois da análise, clique em \"Gerar Peça Jurídica\". Confira o tipo de peça sugerido, altere se for o caso e confirme o preço exibido antes de gerar. O resultado é um rascunho."
      },
      {
        "question": "O que é a validação factual e por que preciso revalidar?",
        "answer": "O sistema confere cada afirmação da peça com o processo e a classifica como Confirmado, Confirmado parcialmente, Não confirmado, Corrigido ou Divergente, com referência às folhas. Se você editar a peça, clique em revalidar antes de exportar."
      },
      {
        "question": "Posso baixar a peça em PDF ou Word?",
        "answer": "Sim. Use \"Exportar Word (.doc)\" ou \"Exportar PDF\". O relatório da análise é exportado em PDF."
      },
      {
        "question": "Posso protocolar diretamente a peça gerada?",
        "answer": "Não. A peça é um rascunho de apoio. A revisão por advogado habilitado é obrigatória antes de qualquer uso ou protocolo."
      }
    ]
  },
  {
    "title": "Créditos e pagamentos",
    "items": [
      {
        "question": "Como compro créditos?",
        "answer": "Clique em \"Comprar créditos\", escolha um pacote e conclua o pagamento na página da Ton, que abre em nova aba. Depois, clique em \"Enviar comprovante para o suporte\" e envie o comprovante pelo WhatsApp."
      },
      {
        "question": "Quais valores estão disponíveis para recarga?",
        "answer": "Os pacotes exibidos na janela \"Comprar créditos\". Confira sempre na tela, pois os valores podem ser alterados."
      },
      {
        "question": "Como pago pela Ton?",
        "answer": "Clique no pacote desejado em \"Comprar créditos\". A página de pagamento da Ton abre em nova aba; use as opções que ela oferecer. Não utilize links ou chaves recebidos por outros meios."
      },
      {
        "question": "Já paguei. Para onde envio o comprovante?",
        "answer": "Na janela \"Comprar créditos\", clique em \"Enviar comprovante para o suporte\". Abre o WhatsApp financeiro (21) 99615-7226 com mensagem pronta; anexe o comprovante."
      },
      {
        "question": "Os créditos entram automaticamente?",
        "answer": "Não. O administrador confere o pagamento e lança os créditos manualmente na sua carteira."
      },
      {
        "question": "Quem libera meus créditos?",
        "answer": "O administrador do Processo 360 IA, após conferir o pagamento, pela função \"Ajustar saldo\"."
      },
      {
        "question": "Quanto tempo demora para os créditos aparecerem?",
        "answer": "O aplicativo informa prazo de até 24 horas para lançamento manual dos créditos, sujeito à confirmação do pagamento pelo administrador."
      },
      {
        "question": "Paguei, mas o saldo não mudou. O que faço?",
        "answer": "Confirme que enviou o comprovante pelo botão \"Enviar comprovante para o suporte\" e aguarde a conferência. Se o prazo passar, fale com o WhatsApp financeiro (21) 99615-7226."
      },
      {
        "question": "Como consulto meu saldo e o histórico?",
        "answer": "O saldo aparece em \"Créditos disponíveis\". O extrato mostra recargas, análises, peças e estornos."
      },
      {
        "question": "E se eu não tiver créditos suficientes?",
        "answer": "A operação é bloqueada e o app mostra quanto falta. Faça uma recarga em \"Comprar créditos\" e tente novamente."
      },
      {
        "question": "Fui cobrado por uma operação que falhou. Perco os créditos?",
        "answer": "Não. Se a análise ou a peça falhar após a cobrança, o valor é devolvido automaticamente e aparece no extrato como \"Estorno\". Se não aparecer, fale com o WhatsApp financeiro."
      }
    ]
  },
  {
    "title": "Segurança e limites",
    "items": [
      {
        "question": "O suporte pode adicionar créditos sem pagamento?",
        "answer": "Não. Créditos só são lançados pelo administrador após a conferência de um pagamento."
      },
      {
        "question": "Enviar o comprovante confirma o pagamento?",
        "answer": "Não. O comprovante apenas informa o pagamento; a confirmação depende da conferência do administrador."
      },
      {
        "question": "Outras pessoas podem ver meu saldo ou meus processos?",
        "answer": "Não. Saldo, extrato e processos são acessíveis apenas na sua conta."
      },
      {
        "question": "Posso negociar ou alterar o preço de uma análise?",
        "answer": "Não. Os preços são definidos pelo sistema e sempre exibidos antes da confirmação."
      },
      {
        "question": "O sistema garante que a peça está pronta para protocolo?",
        "answer": "Não. O conteúdo é um rascunho de apoio e deve ser revisado por advogado habilitado, que confere fatos, fundamentos, documentos e requisitos processuais."
      },
      {
        "question": "Esqueci minha senha. O que faço?",
        "answer": "Fale com o atendimento pelo WhatsApp (21) 99615-7226. Se sua conta estiver vinculada ao Google, você também pode usar \"Entrar com Google\"."
      },
      {
        "question": "Posso pagar com Pix?",
        "answer": "As formas de pagamento são as oferecidas na página da Ton aberta pelo botão do pacote. Não use chaves ou links enviados por outros meios."
      }
    ]
  }
]
