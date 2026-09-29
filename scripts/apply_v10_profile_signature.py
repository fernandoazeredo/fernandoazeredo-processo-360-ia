from pathlib import Path


def patch(path, old, new, count=1):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if text.count(old) < count:
        raise SystemExit(f'{path}: trecho não encontrado: {old[:140]}')
    p.write_text(text.replace(old, new, count), encoding='utf-8')

# 1) Migração segura do e-mail legado que versões antigas copiavam do login.
patch('src/App.tsx',
"""    return onSnapshot(doc(db, 'professionalProfiles', user.uid), snap => {
      if (snap.exists()) {
        const data = snap.data() as Partial<ProfessionalProfile>
        setProfessionalProfile({
          name: String(data.name || ''),
          oab: String(data.oab || ''),
          address: String(data.address || ''),
          email: String(data.email || '')
        })
      }
    })
""",
"""    return onSnapshot(doc(db, 'professionalProfiles', user.uid), async snap => {
      if (snap.exists()) {
        const data = snap.data() as Partial<ProfessionalProfile> & { emailExplicitlySet?: boolean; legacyLoginEmailCleared?: boolean }
        const storedEmail = String(data.email || '').trim()
        const loginEmail = String(user.email || '').trim()
        const isLegacyLoginEmail = Boolean(
          storedEmail && loginEmail &&
          storedEmail.toLowerCase() === loginEmail.toLowerCase() &&
          data.emailExplicitlySet !== true &&
          data.legacyLoginEmailCleared !== true
        )

        // Versões antigas gravavam automaticamente o e-mail de autenticação como e-mail profissional.
        // Limpa esse legado uma única vez. Se o advogado quiser usar o mesmo e-mail profissional,
        // basta digitá-lo e salvar: a partir daí emailExplicitlySet=true preserva a escolha.
        if (isLegacyLoginEmail) {
          try {
            await setDoc(doc(db, 'professionalProfiles', user.uid), {
              email: '',
              emailExplicitlySet: false,
              legacyLoginEmailCleared: true,
              updatedAt: serverTimestamp()
            }, { merge: true })
          } catch (error) {
            console.error('[Processo 360 IA] Falha ao limpar e-mail profissional legado', error)
          }
        }

        setProfessionalProfile({
          name: String(data.name || ''),
          oab: String(data.oab || ''),
          address: String(data.address || ''),
          email: isLegacyLoginEmail ? '' : storedEmail
        })
      }
    })
""")

patch('src/App.tsx',
"""      await setDoc(doc(db, 'professionalProfiles', user.uid), { ...professionalProfile, uid: user.uid, updatedAt: serverTimestamp() }, { merge: true })
""",
"""      await setDoc(doc(db, 'professionalProfiles', user.uid), {
        ...professionalProfile,
        uid: user.uid,
        emailExplicitlySet: true,
        legacyLoginEmailCleared: true,
        updatedAt: serverTimestamp()
      }, { merge: true })
""")

# 2) O endereço profissional deve permanecer no bloco de assinatura mesmo se o revisor da IA o omitir.
patch('src/pieces.ts',
"""function applyDeterministicPieceFields(sections: PieceSection[], professionalProfile: ProfessionalProfile | undefined, pieceDate: string) {
  const profile = professionalProfile || { name: '', oab: '', address: '', email: '' }
  const replacements: Array<[RegExp, string]> = [
    [/\\[(?:NOME DO )?ADVOGADO(?:\\(A\\))?\\]/gi, profile.name],
    [/\\[OAB(?:\\/UF)?\\]/gi, profile.oab],
    [/\\[ENDEREÇO (?:PROFISSIONAL|DO ADVOGADO)\\]/gi, profile.address],
    [/\\[E-?MAIL (?:PROFISSIONAL|DO ADVOGADO)\\]/gi, profile.email],
    [/\\[DATA\\]/gi, pieceDate]
  ]
  return cleanSections(sections.map(section => {
    let title = section.title
    let content = section.content
    for (const [pattern, value] of replacements) {
      if (!value) continue
      title = title.replace(pattern, value)
      content = content.replace(pattern, value)
    }
    return { title, content }
  }))
}
""",
"""function applyDeterministicPieceFields(sections: PieceSection[], professionalProfile: ProfessionalProfile | undefined, pieceDate: string) {
  const profile = professionalProfile || { name: '', oab: '', address: '', email: '' }
  const replacements: Array<[RegExp, string]> = [
    [/\\[(?:NOME DO )?ADVOGADO(?:\\(A\\))?\\]/gi, profile.name],
    [/\\[OAB(?:\\/UF)?\\]/gi, profile.oab],
    [/\\[ENDEREÇO (?:PROFISSIONAL|DO ADVOGADO)\\]/gi, profile.address],
    [/\\[E-?MAIL (?:PROFISSIONAL|DO ADVOGADO)\\]/gi, profile.email],
    [/\\[DATA\\]/gi, pieceDate]
  ]

  const filled = sections.map(section => {
    let title = section.title
    let content = section.content
    for (const [pattern, value] of replacements) {
      if (!value) continue
      title = title.replace(pattern, value)
      content = content.replace(pattern, value)
    }
    return { title, content }
  })

  // A assinatura é dado cadastral determinístico: não pode desaparecer porque o revisor da IA
  // omitiu o placeholder. Se houver endereço cadastrado e ele ainda não estiver na peça,
  // anexa-o ao último bloco que contém nome/OAB do profissional (normalmente o fecho/assinatura).
  const address = String(profile.address || '').trim()
  if (address && !filled.some(section => section.content.toLowerCase().includes(address.toLowerCase()))) {
    const name = String(profile.name || '').trim().toLowerCase()
    const oab = String(profile.oab || '').trim().toLowerCase()
    let signatureIndex = -1
    for (let index = filled.length - 1; index >= 0; index -= 1) {
      const content = String(filled[index].content || '').toLowerCase()
      if ((oab && content.includes(oab)) || (name && content.includes(name))) {
        signatureIndex = index
        break
      }
    }
    if (signatureIndex >= 0) {
      filled[signatureIndex] = {
        ...filled[signatureIndex],
        content: `${filled[signatureIndex].content.trim()}\\n${address}`
      }
    }
  }

  return cleanSections(filled)
}
""")

# Remove arquivos temporários do commit final.
Path('scripts/apply_v10_profile_signature.py').unlink(missing_ok=True)
Path('.github/workflows/apply-v10-profile-signature.yml').unlink(missing_ok=True)
