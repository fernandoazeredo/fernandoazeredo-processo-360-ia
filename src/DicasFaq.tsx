import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { dicasFaqGroups } from './dicasFaq'
import './dicas-faq.css'

const SUPPORT_URL = `https://wa.me/5521996157226?text=${encodeURIComponent('Olá! Estou utilizando o Processo 360 IA, consultei o menu DICAS e preciso de atendimento sobre uma dúvida no aplicativo. Poderiam me ajudar?')}`
const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

export default function DicasFaq() {
  const [search, setSearch] = useState('')
  const [topic, setTopic] = useState('Todos os temas')
  const groups = useMemo(() => dicasFaqGroups
    .filter(group => topic === 'Todos os temas' || group.title === topic)
    .map(group => ({ ...group, items: group.items.filter(item => normalize(item.question + ' ' + item.answer).includes(normalize(search.trim()))) }))
    .filter(group => group.items.length > 0), [search, topic])
  const count = groups.reduce((total, group) => total + group.items.length, 0)
  return (
    <section className="dicas-faq" aria-label="Perguntas frequentes">
      <header className="dicas-faq-intro">
        <h3>Perguntas e respostas por tema</h3>
        <p>Selecione um assunto ou pesquise uma dúvida. Toque na pergunta para abrir a resposta.</p>
      </header>
      <label className="dicas-faq-search">
        <Search size={18} aria-hidden="true" />
        <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Pesquisar uma dúvida..." aria-label="Pesquisar dúvidas" />
      </label>
      <nav className="dicas-faq-topics" aria-label="Temas das perguntas frequentes">
        {['Todos os temas', ...dicasFaqGroups.map(group => group.title)].map(name => (
          <button type="button" key={name} aria-pressed={topic === name} className={topic === name ? 'selected' : ''} onClick={() => setTopic(name)}>{name}</button>
        ))}
      </nav>
      <p className="dicas-faq-count" aria-live="polite">{count} {count === 1 ? 'pergunta encontrada' : 'perguntas encontradas'}</p>
      {groups.length === 0 && <p className="dicas-faq-empty">Nenhuma pergunta encontrada. Experimente outra palavra ou selecione outro tema.</p>}
      {groups.map(group => <section className="dicas-faq-group" key={group.title}>
        <h4>{group.title}</h4>
        {group.items.map(item => <details className="dicas-faq-item" key={item.question}>
          <summary>{item.question}<span aria-hidden="true" className="dicas-faq-sign">+</span></summary>
          <div className="dicas-faq-answer">
            <p>{item.answer}</p>
            {(item.question === 'Esqueci minha senha. O que faço?' || item.question === 'Paguei, mas o saldo não mudou. O que faço?') && <p><a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer"><img src="/assets/whatsapp-icon.svg" width="18" height="18" alt="" aria-hidden="true" /> Falar com o suporte</a></p>}
          </div>
        </details>)}
      </section>)}
      <aside className="dicas-faq-contact">
        <strong>Precisa de atendimento humano?</strong>
        <p>Para dúvidas sobre acesso, conta ou problemas persistentes: <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer"><img src="/assets/whatsapp-icon.svg" width="18" height="18" alt="" aria-hidden="true" /> Falar com o suporte</a>.</p>
        <p><strong>Comprovantes de pagamento:</strong> utilize o botão “Enviar comprovante para o suporte” dentro da janela “Comprar créditos”.</p>
        <small>Este guia não utiliza IA, não consome créditos e não consulta seus dados. As peças jurídicas são rascunhos e exigem revisão por advogado habilitado.</small>
      </aside>
    </section>
  )
}
