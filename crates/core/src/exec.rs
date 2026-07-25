//! Execution policy for independent search branches.
//!
//! Native builds use scoped operating-system threads. WebAssembly builds run
//! the same closures inline so they never depend on host thread support.

#![allow(clippy::redundant_pub_crate)]

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct BranchPanicked;

type JoinResult<T> = std::result::Result<T, BranchPanicked>;

#[cfg(not(target_arch = "wasm32"))]
mod imp {
  use super::{BranchPanicked, JoinResult};

  /// Handle to a branch spawned inside [`scope`].
  pub(crate) struct JoinHandle<'scope, T> {
    inner: std::thread::ScopedJoinHandle<'scope, T>,
  }

  impl<T> JoinHandle<'_, T> {
    /// Wait for the branch and take its result.
    pub(crate) fn join(self) -> JoinResult<T> {
      self.inner.join().map_err(|_| BranchPanicked)
    }
  }

  /// Scope that executes spawned branches concurrently.
  pub(crate) struct Scope<'scope, 'env> {
    inner: &'scope std::thread::Scope<'scope, 'env>,
  }

  impl<'scope> Scope<'scope, '_> {
    /// Spawn a branch that borrows from this scope.
    #[must_use]
    pub(crate) fn spawn<F, T>(&self, branch: F) -> JoinHandle<'scope, T>
    where
      F: FnOnce() -> T + Send + 'scope,
      T: Send + 'scope,
    {
      JoinHandle {
        inner: self.inner.spawn(branch),
      }
    }
  }

  /// Number of native workers available to the process.
  pub(crate) fn available_parallelism() -> usize {
    std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get)
  }

  /// Run a closure with native scoped-thread execution.
  pub(crate) fn scope<'env, F, T>(body: F) -> T
  where
    F: for<'scope> FnOnce(&Scope<'scope, 'env>) -> T,
  {
    std::thread::scope(|inner| body(&Scope { inner }))
  }
}

#[cfg(target_arch = "wasm32")]
mod imp {
  use core::marker::PhantomData;

  use super::JoinResult;

  /// Handle to a branch that has already run inline.
  pub(crate) struct JoinHandle<'scope, T> {
    value: T,
    scope: PhantomData<&'scope ()>,
  }

  impl<T> JoinHandle<'_, T> {
    /// Take the value produced by the inline branch.
    #[allow(clippy::unnecessary_wraps)]
    pub(crate) fn join(self) -> JoinResult<T> {
      Ok(self.value)
    }
  }

  /// Scope that executes every branch inline in spawn order.
  pub(crate) struct Scope<'scope, 'env> {
    scope: PhantomData<&'scope ()>,
    environment: PhantomData<&'env ()>,
  }

  impl<'scope> Scope<'scope, '_> {
    /// Run a branch immediately and retain its result.
    #[allow(clippy::unused_self)]
    #[must_use]
    pub(crate) fn spawn<F, T>(&self, branch: F) -> JoinHandle<'scope, T>
    where
      F: FnOnce() -> T + Send + 'scope,
      T: Send + 'scope,
    {
      JoinHandle {
        value: branch(),
        scope: PhantomData,
      }
    }
  }

  /// WebAssembly execution is single-threaded.
  pub(crate) const fn available_parallelism() -> usize {
    1
  }

  /// Run a closure with inline sequential execution.
  pub(crate) fn scope<'env, F, T>(body: F) -> T
  where
    F: for<'scope> FnOnce(&Scope<'scope, 'env>) -> T,
  {
    body(&Scope {
      scope: PhantomData,
      environment: PhantomData,
    })
  }
}

pub(crate) use imp::{available_parallelism, scope};
