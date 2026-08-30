import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0" +
" hover-elevate active-elevate-2",
  {
    variants: {
      variant: {
        /*
         * `aura-btn` on the filled variants, so the look Osama picked lands on
         * every button in the product rather than on the handful somebody
         * remembers to decorate. Fifty call sites, one class.
         *
         * `no-default-hover-elevate` with it, because the two fight: the base
         * class above adds `hover-elevate`, which brightens a translucent
         * overlay on hover, and `.aura-btn` says what hover means by growing
         * its ring. Two answers to one question is how a button ends up doing
         * neither well.
         *
         * The border goes with it. `.aura-btn` is edged by its ring and its
         * inset; a stroke on top of both is what makes a button look like a div
         * with a background colour — and on the primary variant that stroke was
         * `--primary-border`, undefined until today, which is to say white.
         */
        default:
           "bg-primary text-primary-foreground aura-btn no-default-hover-elevate",
        destructive:
          "bg-destructive-fill text-destructive-foreground aura-btn no-default-hover-elevate",
        outline:
          // @replit Shows the background color of whatever card / sidebar / accent background it is inside of.
          // Inherits the current text color. Uses shadow-xs. no shadow on active
          // No hover state
          " border [border-color:var(--button-outline)] shadow-xs active:shadow-none ",
        secondary:
          "bg-secondary text-secondary-foreground aura-btn no-default-hover-elevate",
        // @replit no hover, transparent border
        ghost: "border border-transparent",
        // A text link inside a sentence keeps its type size, but the box a
        // thumb has to hit is 20px tall and that is not a target. The height
        // comes from the box, not the text, so the sentence still reads the
        // same — it is only easier to press.
        link: "text-primary underline-offset-4 hover:underline min-h-11 md:min-h-0",
      },
      // Two heights, not one. A 36px button is comfortable under a mouse and
      // a coin-toss under a thumb — Apple and Google both publish 44px as the
      // floor, and every button in this app inherits from right here, so the
      // whole product is either above that line or below it depending on this
      // object. `md:` rather than `sm:` because a tablet is still touched.
      size: {
        // @replit changed sizes
        default: "min-h-11 md:min-h-9 px-4 py-2",
        sm: "min-h-9 md:min-h-8 rounded-md px-3 text-xs",
        lg: "min-h-12 md:min-h-10 rounded-md px-8",
        icon: "h-11 w-11 md:h-9 md:w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
