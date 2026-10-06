import type { AttachmentSummary } from '../../lib/ai/attachments';
import { AttachmentList } from './AttachmentList';

interface Props {
  content: string;
  attachments?: AttachmentSummary[];
  /** Sent while the agent was working and not yet delivered to it. */
  queued?: boolean;
}

export function ChatMessageUser({ content, queued, attachments = [] }: Props) {
  return (
    <div className="flex flex-col items-end">
      <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[80%] text-sm whitespace-pre-wrap">
        {content && <p>{content}</p>}
        <AttachmentList files={attachments} />
      </div>
      {queued && <p className="mt-1 text-[11px] text-muted-foreground">Queued · the agent reads this after its current step</p>}
    </div>
  );
}
