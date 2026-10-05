import React from 'react'
import * as AccordionPrimitive from '@radix-ui/react-accordion'
import { ChevronRight } from 'lucide-react'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import {
    collectExpandableIds,
    revealPath,
    toggleExpanded,
} from '@/lib/tree-expansion'

const treeVariants = cva(
    'group rounded-md px-2 hover:bg-muted/60 transition-colors'
)

const selectedTreeVariants = cva(
    'bg-soil-200 dark:bg-soil-900/40 text-foreground font-semibold hover:bg-soil-300 dark:hover:bg-soil-900/60 border-l-2 border-sun-600 dark:border-sun-300'
)

const dragOverVariants = cva(
    'before:opacity-100 before:bg-primary/20 text-primary-foreground'
)

interface TreeDataItem {
    id: string
    name: string
    icon?: React.ComponentType<{ className?: string }>
    selectedIcon?: React.ComponentType<{ className?: string }>
    openIcon?: React.ComponentType<{ className?: string }>
    children?: TreeDataItem[]
    actions?: React.ReactNode
    onClick?: () => void
    draggable?: boolean
    droppable?: boolean
    disabled?: boolean
    className?: string
    /** Hover tooltip for the node's label (e.g. a column's comment). */
    title?: string
}

type TreeRenderItemParams = {
    item: TreeDataItem
    level: number
    isLeaf: boolean
    isSelected: boolean
    isOpen?: boolean
    hasChildren: boolean
}

type TreeProps = React.HTMLAttributes<HTMLDivElement> & {
    data: TreeDataItem[] | TreeDataItem
    initialSelectedItemId?: string
    /** The click/key event is passed so a caller can treat modifier clicks
     *  differently; call `preventDefault()` on it to skip selecting the item. */
    onSelectChange?: (item: TreeDataItem | undefined, event?: React.MouseEvent | React.KeyboardEvent) => void
    /** Hover/focus preview for a row, rendered lazily when the card opens.
     *  Return null for rows without one. */
    renderHover?: (item: TreeDataItem) => React.ReactNode | null
    expandAll?: boolean
    defaultNodeIcon?: React.ComponentType<{ className?: string }>
    defaultLeafIcon?: React.ComponentType<{ className?: string }>
    onDocumentDrag?: (sourceItem: TreeDataItem, targetItem: TreeDataItem) => void
    renderItem?: (params: TreeRenderItemParams) => React.ReactNode
    /** Space below the last row for dropping onto the root. Off when something follows the tree. */
    trailingDropZone?: boolean
}

type SelectHandler = (item: TreeDataItem | undefined, event?: React.MouseEvent | React.KeyboardEvent) => void

/** Select an item: update selection state and fire its own click handler. */
function activateItem(
    item: TreeDataItem,
    handleSelectChange: SelectHandler,
    event?: React.MouseEvent | React.KeyboardEvent
) {
    handleSelectChange(item, event)
    if (event?.defaultPrevented) return
    item.onClick?.()
}

const HOVER_DELAY_MS = 400

interface HoverApi {
    enter: (item: TreeDataItem, el: HTMLElement, immediate?: boolean) => void
    leave: () => void
}

/** Rows report hover/focus here; the TreeView draws one card for the tree. */
const HoverContext = React.createContext<HoverApi | null>(null)

function useRowHover(item: TreeDataItem) {
    const api = React.useContext(HoverContext)
    if (!api) return {}
    return {
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => api.enter(item, e.currentTarget),
        onMouseLeave: () => api.leave(),
        onFocus: (e: React.FocusEvent<HTMLElement>) => {
            // Only the row itself, not an action button inside it.
            if (e.target === e.currentTarget) api.enter(item, e.currentTarget, false)
        },
        onBlur: () => api.leave(),
    }
}

/** The single floating preview card, beside the row it describes. */
function TreeHoverCard({ rect, children }: { rect: DOMRect; children: React.ReactNode }) {
    const ref = React.useRef<HTMLDivElement>(null)
    const [top, setTop] = React.useState(rect.top)
    React.useLayoutEffect(() => {
        const h = ref.current?.offsetHeight ?? 0
        setTop(Math.max(8, Math.min(rect.top, window.innerHeight - h - 8)))
    }, [rect])
    const left = Math.min(rect.right + 8, window.innerWidth - 336)
    return (
        <div
            ref={ref}
            id="tree-hover-card"
            role="tooltip"
            data-testid="tree-hover-card"
            className="fixed z-50 w-80 max-w-[calc(100vw-16px)] rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-3 text-xs pointer-events-none"
            style={{ top, left: Math.max(8, left) }}
        >
            {children}
        </div>
    )
}

/**
 * Shared drag-and-drop handlers for tree rows. `respectDisabled` makes a
 * disabled item inert (used by leaves; nodes are never disabled).
 */
function useTreeDrag(
    item: TreeDataItem,
    {
        handleDragStart,
        handleDrop,
        draggedItem,
        respectDisabled,
    }: {
        handleDragStart?: (item: TreeDataItem) => void
        handleDrop?: (item: TreeDataItem) => void
        draggedItem: TreeDataItem | null
        respectDisabled?: boolean
    }
) {
    const [isDragOver, setIsDragOver] = React.useState(false)
    const disabled = respectDisabled ? !!item.disabled : false

    const dragProps = {
        draggable: !!item.draggable && !disabled,
        onDragStart: (e: React.DragEvent) => {
            if (!item.draggable || disabled) {
                e.preventDefault()
                return
            }
            e.dataTransfer.setData('text/plain', item.id)
            handleDragStart?.(item)
        },
        onDragOver: (e: React.DragEvent) => {
            if (
                item.droppable !== false &&
                !disabled &&
                draggedItem &&
                draggedItem.id !== item.id
            ) {
                e.preventDefault()
                setIsDragOver(true)
            }
        },
        onDragLeave: () => setIsDragOver(false),
        onDrop: (e: React.DragEvent) => {
            if (disabled) return
            e.preventDefault()
            setIsDragOver(false)
            handleDrop?.(item)
        },
    }

    return { isDragOver, dragProps }
}

const TreeView = React.forwardRef<HTMLDivElement, TreeProps>(
    (
        {
            data,
            initialSelectedItemId,
            onSelectChange,
            renderHover,
            expandAll,
            defaultLeafIcon,
            defaultNodeIcon,
            className,
            onDocumentDrag,
            renderItem,
            trailingDropZone = true,
            ...props
        },
        ref
    ) => {
        // Kept out of context so opening a card doesn't re-render every row.
        const [hover, setHover] = React.useState<{ item: TreeDataItem; el: HTMLElement; rect: DOMRect } | null>(null)
        const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
        const renderHoverRef = React.useRef(renderHover)
        renderHoverRef.current = renderHover
        const hoverApi = React.useMemo<HoverApi | null>(() => renderHover ? {
            enter: (item, el, immediate) => {
                if (hoverTimer.current) clearTimeout(hoverTimer.current)
                const open = () => setHover({ item, el, rect: el.getBoundingClientRect() })
                if (immediate === false) open()
                else hoverTimer.current = setTimeout(open, HOVER_DELAY_MS)
            },
            leave: () => {
                if (hoverTimer.current) clearTimeout(hoverTimer.current)
                hoverTimer.current = null
                setHover(null)
            },
        } : null, [!!renderHover]) // eslint-disable-line react-hooks/exhaustive-deps
        React.useEffect(() => {
            if (!hover) return
            const close = () => hoverApi?.leave()
            const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
            window.addEventListener('scroll', close, true)
            window.addEventListener('keydown', onKey)
            window.addEventListener('pointerdown', close, true)
            return () => {
                window.removeEventListener('scroll', close, true)
                window.removeEventListener('keydown', onKey)
                window.removeEventListener('pointerdown', close, true)
            }
        }, [hover, hoverApi])
        React.useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }, [])
        const hoverContent = hover ? renderHoverRef.current?.(hover.item) ?? null : null
        React.useEffect(() => {
            if (!hover || !hoverContent) return
            const el = hover.el
            el.setAttribute('aria-describedby', 'tree-hover-card')
            return () => el.removeAttribute('aria-describedby')
        }, [hover, !!hoverContent]) // eslint-disable-line react-hooks/exhaustive-deps

        const [selectedItemId, setSelectedItemId] = React.useState<
            string | undefined
        >(initialSelectedItemId)

        // Sync selection when controlled prop changes (e.g. content panel navigation)
        React.useEffect(() => {
            if (initialSelectedItemId !== undefined) {
                setSelectedItemId(initialSelectedItemId)
            }
        }, [initialSelectedItemId])

        const [draggedItem, setDraggedItem] = React.useState<TreeDataItem | null>(null)

        const handleSelectChange = React.useCallback(
            (item: TreeDataItem | undefined, event?: React.MouseEvent | React.KeyboardEvent) => {
                if (onSelectChange) {
                    onSelectChange(item, event)
                }
                if (!event?.defaultPrevented) setSelectedItemId(item?.id)
            },
            [onSelectChange]
        )

        const handleDragStart = React.useCallback((item: TreeDataItem) => {
            setDraggedItem(item)
        }, [])

        const handleDrop = React.useCallback((targetItem: TreeDataItem) => {
            if (draggedItem && onDocumentDrag && draggedItem.id !== targetItem.id) {
                onDocumentDrag(draggedItem, targetItem)
            }
            setDraggedItem(null)
        }, [draggedItem, onDocumentDrag])

        const dataArray = React.useMemo(
            () => (Array.isArray(data) ? data : [data]),
            [data]
        )

        // Single source of truth for expansion: the set of expanded node ids.
        // The chevron toggles ids directly; external navigation only *reveals*
        // (adds ancestors), so a user's collapse is never undone in the same tick.
        const [expanded, setExpanded] = React.useState<Set<string>>(() =>
            revealPath(new Set(), dataArray, initialSelectedItemId)
        )

        React.useEffect(() => {
            if (initialSelectedItemId !== undefined) {
                setExpanded((prev) => revealPath(prev, dataArray, initialSelectedItemId))
            }
        }, [initialSelectedItemId, dataArray])

        const handleToggleExpand = React.useCallback((id: string) => {
            setExpanded((prev) => toggleExpanded(prev, id))
        }, [])

        // While searching (expandAll), reveal everything transiently without
        // mutating the user's manual state, so it is restored when search clears.
        const effectiveExpanded = React.useMemo(
            () => (expandAll ? new Set(collectExpandableIds(dataArray)) : expanded),
            [expandAll, dataArray, expanded]
        )

        return (
            <HoverContext.Provider value={hoverApi}>
            <div className={cn('relative', className)}>
                <TreeItem
                    data={data}
                    ref={ref}
                    selectedItemId={selectedItemId}
                    handleSelectChange={handleSelectChange}
                    expanded={effectiveExpanded}
                    onToggleExpand={handleToggleExpand}
                    defaultLeafIcon={defaultLeafIcon}
                    defaultNodeIcon={defaultNodeIcon}
                    handleDragStart={handleDragStart}
                    handleDrop={handleDrop}
                    draggedItem={draggedItem}
                    renderItem={renderItem}
                    level={0}
                    {...props}
                />
                {trailingDropZone && <div
                    className='w-full h-[48px]'
                    onDrop={() => { handleDrop({id: '', name: 'parent_div'})}}>
                </div>}
                {hover && hoverContent && <TreeHoverCard rect={hover.rect}>{hoverContent}</TreeHoverCard>}
            </div>
            </HoverContext.Provider>
        )
    }
)
TreeView.displayName = 'TreeView'

type TreeItemProps = TreeProps & {
    selectedItemId?: string
    handleSelectChange: SelectHandler
    expanded: Set<string>
    onToggleExpand: (id: string) => void
    defaultNodeIcon?: React.ComponentType<{ className?: string }>
    defaultLeafIcon?: React.ComponentType<{ className?: string }>
    handleDragStart?: (item: TreeDataItem) => void
    handleDrop?: (item: TreeDataItem) => void
    draggedItem: TreeDataItem | null
    level?: number
}

const TreeItem = React.forwardRef<HTMLDivElement, TreeItemProps>(
    (
        {
            className,
            data,
            selectedItemId,
            handleSelectChange,
            expanded,
            onToggleExpand,
            defaultNodeIcon,
            defaultLeafIcon,
            handleDragStart,
            handleDrop,
            draggedItem,
            renderItem,
            level,
            onSelectChange,
            renderHover,
            expandAll,
            initialSelectedItemId,
            onDocumentDrag,
            ...props
        },
        ref
    ) => {
        if (!(Array.isArray(data))) {
            data = [data]
        }
        const isRoot = (level ?? 0) === 0
        return (
            <div ref={ref} className={className}>
                {/* role="none" on the list wrappers: a `tree` (or `group`) must
                    contain `treeitem` children directly, and <ul>/<li> would
                    otherwise interpose implicit list/listitem roles and break
                    that relationship. */}
                <ul role={isRoot ? "tree" : "group"}>
                    {data.map((item) => (
                        <li role="none" key={item.id}>
                            {item.children ? (
                                <TreeNode
                                    item={item}
                                    level={level ?? 0}
                                    selectedItemId={selectedItemId}
                                    expanded={expanded}
                                    onToggleExpand={onToggleExpand}
                                    handleSelectChange={handleSelectChange}
                                    defaultNodeIcon={defaultNodeIcon}
                                    defaultLeafIcon={defaultLeafIcon}
                                    handleDragStart={handleDragStart}
                                    handleDrop={handleDrop}
                                    draggedItem={draggedItem}
                                    renderItem={renderItem}
                                />
                            ) : (
                                <TreeLeaf
                                    item={item}
                                    level={level ?? 0}
                                    selectedItemId={selectedItemId}
                                    handleSelectChange={handleSelectChange}
                                    defaultLeafIcon={defaultLeafIcon}
                                    handleDragStart={handleDragStart}
                                    handleDrop={handleDrop}
                                    draggedItem={draggedItem}
                                    renderItem={renderItem}
                                />
                            )}
                        </li>
                    ))}
                </ul>
            </div>
        )
    }
)
TreeItem.displayName = 'TreeItem'

const TreeNode = ({
    item,
    handleSelectChange,
    expanded,
    onToggleExpand,
    selectedItemId,
    defaultNodeIcon,
    defaultLeafIcon,
    handleDragStart,
    handleDrop,
    draggedItem,
    renderItem,
    level = 0,
}: {
    item: TreeDataItem
    handleSelectChange: SelectHandler
    expanded: Set<string>
    onToggleExpand: (id: string) => void
    selectedItemId?: string
    defaultNodeIcon?: React.ComponentType<{ className?: string }>
    defaultLeafIcon?: React.ComponentType<{ className?: string }>
    handleDragStart?: (item: TreeDataItem) => void
    handleDrop?: (item: TreeDataItem) => void
    draggedItem: TreeDataItem | null
    renderItem?: (params: TreeRenderItemParams) => React.ReactNode
    level?: number
}) => {
    const { isDragOver, dragProps } = useTreeDrag(item, {
        handleDragStart,
        handleDrop,
        draggedItem,
    })
    const hoverProps = useRowHover(item)
    const hasChildren = !!item.children?.length
    const isSelected = selectedItemId === item.id
    const isOpen = expanded.has(item.id)

    return (
        <AccordionPrimitive.Root
            type="multiple"
            value={isOpen ? [item.id] : []}
            onValueChange={() => onToggleExpand(item.id)}
        >
            <AccordionPrimitive.Item value={item.id}>
                {/* Branch nodes are treeitems too. Only TreeLeaf carried the
                    role before, so a tree of collapsed schemas exposed no
                    treeitem at all — unusable as a tree for screen readers.
                    The role goes on the ROW (the trigger), matching TreeLeaf,
                    not on the wrapping Item: the Item also contains the
                    expanded child group, so a treeitem there would take its
                    accessible name from every descendant, and its click target
                    would cover the children rather than the row. */}
                <AccordionTrigger
                    role="treeitem"
                    aria-expanded={isOpen}
                    className={cn(
                        treeVariants(),
                        isSelected && selectedTreeVariants(),
                        isDragOver && dragOverVariants(),
                        item.className
                    )}
                    onClick={(e) => activateItem(item, handleSelectChange, e)}
                    {...hoverProps}
                    {...dragProps}
                >
                    {renderItem ? (
                        renderItem({
                            item,
                            level,
                            isLeaf: false,
                            isSelected,
                            isOpen,
                            hasChildren,
                        })
                    ) : (
                        <>
                            <TreeIcon
                                item={item}
                                isSelected={isSelected}
                                isOpen={isOpen}
                                default={defaultNodeIcon}
                            />
                            <span className="text-sm truncate" title={item.title}>{item.name}</span>
                            <TreeActions isSelected={isSelected}>
                                {item.actions}
                            </TreeActions>
                        </>
                    )}
                </AccordionTrigger>
                <AccordionContent role="group" className="ml-4 pl-1 border-l">
                    <TreeItem
                        data={item.children ? item.children : item}
                        selectedItemId={selectedItemId}
                        handleSelectChange={handleSelectChange}
                        expanded={expanded}
                        onToggleExpand={onToggleExpand}
                        defaultLeafIcon={defaultLeafIcon}
                        defaultNodeIcon={defaultNodeIcon}
                        handleDragStart={handleDragStart}
                        handleDrop={handleDrop}
                        draggedItem={draggedItem}
                        renderItem={renderItem}
                        level={level + 1}
                    />
                </AccordionContent>
            </AccordionPrimitive.Item>
        </AccordionPrimitive.Root>
    )
}

const TreeLeaf = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & {
        item: TreeDataItem
        level: number
        selectedItemId?: string
        handleSelectChange: SelectHandler
        defaultLeafIcon?: React.ComponentType<{ className?: string }>
        handleDragStart?: (item: TreeDataItem) => void
        handleDrop?: (item: TreeDataItem) => void
        draggedItem: TreeDataItem | null
        renderItem?: (params: TreeRenderItemParams) => React.ReactNode
    }
>(
    (
        {
            className,
            item,
            level,
            selectedItemId,
            handleSelectChange,
            defaultLeafIcon,
            handleDragStart,
            handleDrop,
            draggedItem,
            renderItem,
            ...props
        },
        ref
    ) => {
        const { isDragOver, dragProps } = useTreeDrag(item, {
            handleDragStart,
            handleDrop,
            draggedItem,
            respectDisabled: true,
        })
        const hoverProps = useRowHover(item)
        const isSelected = selectedItemId === item.id

        return (
            <div
                ref={ref}
                role="treeitem"
                tabIndex={0}
                className={cn(
                    'ml-5 flex text-left items-center py-2 cursor-pointer before:right-1 overflow-hidden',
                    treeVariants(),
                    className,
                    isSelected && selectedTreeVariants(),
                    isDragOver && dragOverVariants(),
                    item.disabled && 'opacity-50 cursor-not-allowed pointer-events-none',
                    item.className
                )}
                onKeyDown={(e) => {
                    if (item.disabled) return
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        activateItem(item, handleSelectChange, e)
                    }
                }}
                onClick={(e) => {
                    if (item.disabled) return
                    activateItem(item, handleSelectChange, e)
                }}
                {...hoverProps}
                {...dragProps}
                {...props}
            >
                {renderItem ? (
                    <>
                        <div className="h-4 w-4 shrink-0 mr-1" />
                        {renderItem({
                            item,
                            level,
                            isLeaf: true,
                            isSelected,
                            hasChildren: false,
                        })}
                    </>
                ) : (
                    <>
                        <TreeIcon
                            item={item}
                            isSelected={isSelected}
                            default={defaultLeafIcon}
                        />
                        <span className="flex-grow text-sm truncate" title={item.title}>{item.name}</span>
                        <TreeActions isSelected={isSelected && !item.disabled}>
                            {item.actions}
                        </TreeActions>
                    </>
                )}
            </div>
        )
    }
)
TreeLeaf.displayName = 'TreeLeaf'

const AccordionTrigger = React.forwardRef<
    React.ComponentRef<typeof AccordionPrimitive.Trigger>,
    React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
    <AccordionPrimitive.Header asChild>
        <div>
            <AccordionPrimitive.Trigger
                ref={ref}
                className={cn(
                    'flex flex-1 w-full items-center py-2 transition-all first:[&[data-state=open]>svg]:first-of-type:rotate-90',
                    className
                )}
                {...props}
            >
                <ChevronRight className="h-4 w-4 shrink-0 transition-transform duration-200 text-muted-foreground/60 mr-1" />
                {children}
            </AccordionPrimitive.Trigger>
        </div>
    </AccordionPrimitive.Header>
))
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName

const AccordionContent = React.forwardRef<
    React.ComponentRef<typeof AccordionPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => (
    <AccordionPrimitive.Content
        ref={ref}
        className={cn(
            'overflow-hidden text-sm transition-all data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down',
            className
        )}
        {...props}
    >
        <div className="pb-1 pt-0">{children}</div>
    </AccordionPrimitive.Content>
))
AccordionContent.displayName = AccordionPrimitive.Content.displayName

const TreeIcon = ({
    item,
    isOpen,
    isSelected,
    default: defaultIcon
}: {
    item: TreeDataItem
    isOpen?: boolean
    isSelected?: boolean
    default?: React.ComponentType<{ className?: string }>
}) => {
    let Icon: React.ComponentType<{ className?: string }> | undefined = defaultIcon
    if (isSelected && item.selectedIcon) {
        Icon = item.selectedIcon
    } else if (isOpen && item.openIcon) {
        Icon = item.openIcon
    } else if (item.icon) {
        Icon = item.icon
    }
    return Icon ? (
        <Icon className="h-4 w-4 shrink-0 mr-2" />
    ) : (
        <></>
    )
}

const TreeActions = ({
    children,
}: {
    children: React.ReactNode
    isSelected: boolean
}) => {
    if (!children) return null
    return (
        <div className="ml-auto min-w-0 overflow-hidden">
            {children}
        </div>
    )
}

export {
    TreeView,
    type TreeDataItem,
    type TreeRenderItemParams,
    AccordionTrigger,
    AccordionContent,
    TreeLeaf,
    TreeNode,
    TreeItem
}
