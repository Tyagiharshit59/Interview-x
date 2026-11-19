import { useNavigate, useParams } from 'react-router-dom';
import { post } from '../api';
import { useAuth } from '../auth';
import { RoomView } from './RoomView';

export function Room() {
  const { id } = useParams(); const nav = useNavigate(); const { me } = useAuth();
  const info = { current: null as any };
  return (
    <RoomView kind="staff" interviewId={id} displayName={me?.user.name || 'Interviewer'} title="Interview room"
      getTicket={async () => { const r = await post(`/interviews/${id}/room-ticket`); info.current = r; return r; }}
      onExit={() => nav(`/interviews/${id}`)}
      notice={{ recording: '', secondaryCamera: '' }} />
  );
}
