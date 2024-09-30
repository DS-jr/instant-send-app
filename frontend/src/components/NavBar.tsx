"use client";
import React from "react";
import { useState, useEffect } from "react";
import { useTheme } from "next-themes";

const Navbar = () => {
  const { setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    setTheme("dark");
  }, []);

  if (!mounted) return null;

  return (
    <nav className="flex justify-between items-center py-4">
      <div className="flex items-center gap-2">
        <div className="flex flex-col gap-4">
          <span className="tracking-tighter text-3xl font-extrabold text-primary flex gap-2 items-center">
            Instant Send App{" "}
          </span>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
