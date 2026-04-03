interface Props {
  content: string;
}

export function ChatMessageUser({ content }: Props) {
  return (
    <div className="flex justify-end">
      <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[80%] text-sm whitespace-pre-wrap">
        {content}
      </div>
    </div>
  );
}
