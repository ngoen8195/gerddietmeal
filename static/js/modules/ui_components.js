/**
 * Pro Max UI Interaction Library
 * Handles micro-interactions, scroll reveals, and parallax effects.
 */

export const UI = {
    init() {
        this.initScrollReveal();
        this.initButtons();
        this.initParallax();
    },

    /**
     * Staggered Scroll Reveal
     */
    initScrollReveal() {
        const observerOptions = {
            threshold: 0.1,
            rootMargin: '0px 0px -50px 0px'
        };

        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry, index) => {
                if (entry.isIntersecting) {
                    const delay = entry.target.dataset.delay || index * 100;
                    setTimeout(() => {
                        entry.target.classList.add('revealed');
                    }, delay);
                    observer.unobserve(entry.target);
                }
            });
        }, observerOptions);

        document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
    },

    /**
     * Enhanced Button Micro-interactions
     */
    initButtons() {
        document.querySelectorAll('.btn-premium').forEach(btn => {
            btn.addEventListener('mouseenter', () => {
                // Handle complex animations if needed
            });
        });
    },

    /**
     * GPU-Accelerated Parallax
     */
    initParallax() {
        window.addEventListener('scroll', () => {
            const scrolled = window.pageYOffset;
            document.querySelectorAll('.parallax').forEach(el => {
                const speed = el.dataset.speed || 0.5;
                el.style.transform = `translateY(${scrolled * speed}px)`;
            });
        }, { passive: true });
    }
};

// Auto-initialize on load
document.addEventListener('DOMContentLoaded', () => UI.init());
