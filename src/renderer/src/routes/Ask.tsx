import { useNavigate } from 'react-router-dom'
import AskPanel from '../components/AskPanel'

/** Library-wide question answering, grounded in every indexed recording's transcript. */
export default function Ask(): React.JSX.Element {
  const navigate = useNavigate()

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>Ask</h1>
          <p className="page__subtitle">Ask questions across every transcribed recording</p>
        </div>
      </header>

      <AskPanel
        onNavigateToRecording={(id, ms) => navigate(`/recordings/${id}`, { state: { seekMs: ms } })}
      />
    </div>
  )
}
