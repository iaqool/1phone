use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use spl_token_2022::{
    extension::{metadata_pointer::MetadataPointer, BaseStateWithExtensions, StateWithExtensions},
    state::{Account as Token2022Account, AccountState, Mint as Token2022Mint},
};
use spl_token_group_interface::state::TokenGroupMember;
use std::str::FromStr;

declare_id!("B3mxNzFAtqWt14m6rr6ExRYeWw29V4vU8bvv9q17xR7N");

#[program]
pub mod onephone {
    use super::*;

    pub fn register_namespace(ctx: Context<RegisterNamespace>, scope: [u8; 32], deadline: i64) -> Result<()> {
        require!(scope != [0; 32] && deadline > Clock::get()?.unix_timestamp, OnephoneError::InvalidTerms);
        let namespace = &mut ctx.accounts.namespace;
        namespace.authority = ctx.accounts.authority.key();
        namespace.scope = scope;
        namespace.deadline = deadline;
        namespace.bump = ctx.bumps.namespace;
        Ok(())
    }

    pub fn consume(ctx: Context<Consume>) -> Result<()> {
        require!(Clock::get()?.unix_timestamp < ctx.accounts.namespace.deadline, OnephoneError::Expired);
        verify_sgt(
            &ctx.accounts.sgt_mint.to_account_info(),
            &ctx.accounts.sgt_token.to_account_info(),
            &ctx.accounts.holder.key(),
        )?;
        let receipt = &mut ctx.accounts.eligibility;
        receipt.namespace = ctx.accounts.namespace.key();
        receipt.sgt_mint = ctx.accounts.sgt_mint.key();
        receipt.holder = ctx.accounts.holder.key();
        receipt.timestamp = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn init_campaign(
        ctx: Context<InitCampaign>,
        id: [u8; 32],
        reward_amount: u64,
        max_claims: u32,
        deadline: i64,
    ) -> Result<()> {
        require!(reward_amount > 0 && max_claims > 0, OnephoneError::InvalidTerms);
        require!(deadline > Clock::get()?.unix_timestamp, OnephoneError::InvalidTerms);
        let total = reward_amount
            .checked_mul(u64::from(max_claims))
            .ok_or(OnephoneError::ArithmeticOverflow)?;

        let campaign = &mut ctx.accounts.campaign;
        campaign.authority = ctx.accounts.authority.key();
        campaign.id = id;
        campaign.reward_mint = ctx.accounts.reward_mint.key();
        campaign.reward_amount = reward_amount;
        campaign.max_claims = max_claims;
        campaign.claims = 0;
        campaign.deadline = deadline;
        campaign.vault = ctx.accounts.vault.key();
        campaign.closed = false;
        campaign.bump = ctx.bumps.campaign;

        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.reward_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        );
        token::transfer_checked(cpi, total, ctx.accounts.reward_mint.decimals)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        require!(!campaign.closed, OnephoneError::CampaignClosed);
        require!(Clock::get()?.unix_timestamp < campaign.deadline, OnephoneError::Expired);
        require!(campaign.claims < campaign.max_claims, OnephoneError::ClaimLimit);
        verify_sgt(
            &ctx.accounts.sgt_mint.to_account_info(),
            &ctx.accounts.sgt_token.to_account_info(),
            &ctx.accounts.holder.key(),
        )?;

        let signer_seeds: &[&[u8]] = &[
            b"campaign",
            campaign.authority.as_ref(),
            campaign.id.as_ref(),
            &[campaign.bump],
        ];
        let signer = &[signer_seeds];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.reward_mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: campaign.to_account_info(),
            },
            signer,
        );
        token::transfer_checked(cpi, campaign.reward_amount, ctx.accounts.reward_mint.decimals)?;

        let campaign = &mut ctx.accounts.campaign;
        campaign.claims = campaign.claims.checked_add(1).ok_or(OnephoneError::ArithmeticOverflow)?;
        let receipt = &mut ctx.accounts.receipt;
        receipt.campaign = campaign.key();
        receipt.sgt_mint = ctx.accounts.sgt_mint.key();
        receipt.holder = ctx.accounts.holder.key();
        Ok(())
    }

    pub fn close_campaign(ctx: Context<CloseCampaign>) -> Result<()> {
        require!(!ctx.accounts.campaign.closed, OnephoneError::CampaignClosed);
        require!(Clock::get()?.unix_timestamp >= ctx.accounts.campaign.deadline, OnephoneError::TooEarly);

        let campaign = &ctx.accounts.campaign;
        let signer_seeds: &[&[u8]] = &[
            b"campaign",
            campaign.authority.as_ref(),
            campaign.id.as_ref(),
            &[campaign.bump],
        ];
        let signer = &[signer_seeds];
        let remaining = ctx.accounts.vault.amount;
        if remaining > 0 {
            let cpi = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.refund.to_account_info(),
                    authority: campaign.to_account_info(),
                },
                signer,
            );
            token::transfer_checked(cpi, remaining, ctx.accounts.reward_mint.decimals)?;
        }
        ctx.accounts.campaign.closed = true;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(scope: [u8; 32])]
pub struct RegisterNamespace<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = Namespace::SPACE,
        seeds = [b"namespace", authority.key().as_ref(), scope.as_ref()],
        bump
    )]
    pub namespace: Account<'info, Namespace>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Consume<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(
        seeds = [b"namespace", namespace.authority.as_ref(), namespace.scope.as_ref()],
        bump = namespace.bump
    )]
    pub namespace: Account<'info, Namespace>,
    #[account(
        init,
        payer = holder,
        space = EligibilityReceipt::SPACE,
        seeds = [b"eligibility", namespace.key().as_ref(), sgt_mint.key().as_ref()],
        bump
    )]
    pub eligibility: Account<'info, EligibilityReceipt>,
    /// CHECK: verified by verify_sgt.
    pub sgt_mint: UncheckedAccount<'info>,
    /// CHECK: verified by verify_sgt.
    pub sgt_token: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Namespace {
    pub authority: Pubkey,
    pub scope: [u8; 32],
    pub deadline: i64,
    pub bump: u8,
}

impl Namespace {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1;
}

#[account]
pub struct EligibilityReceipt {
    pub namespace: Pubkey,
    pub sgt_mint: Pubkey,
    pub holder: Pubkey,
    pub timestamp: i64,
}

impl EligibilityReceipt {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8;
}

fn verify_sgt(mint_info: &AccountInfo, token_info: &AccountInfo, holder: &Pubkey) -> Result<()> {
    require_keys_eq!(*mint_info.owner, spl_token_2022::id(), OnephoneError::InvalidSgt);
    require_keys_eq!(*token_info.owner, spl_token_2022::id(), OnephoneError::InvalidSgt);
    let authority = Pubkey::from_str("GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4")
        .map_err(|_| OnephoneError::InvalidSgt)?;
    let group = Pubkey::from_str("GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te")
        .map_err(|_| OnephoneError::InvalidSgt)?;
    {
        let data = mint_info.try_borrow_data()?;
        let mint = StateWithExtensions::<Token2022Mint>::unpack(&data)
            .map_err(|_| OnephoneError::InvalidSgt)?;
        require!(mint.base.mint_authority == COption::Some(authority), OnephoneError::InvalidSgt);
        let pointer = mint.get_extension::<MetadataPointer>().map_err(|_| OnephoneError::InvalidSgt)?;
        require!(Option::<Pubkey>::from(pointer.authority) == Some(authority), OnephoneError::InvalidSgt);
        require!(Option::<Pubkey>::from(pointer.metadata_address) == Some(group), OnephoneError::InvalidSgt);
        let member = mint.get_extension::<TokenGroupMember>().map_err(|_| OnephoneError::InvalidSgt)?;
        require_keys_eq!(member.group, group, OnephoneError::InvalidSgt);
        require_keys_eq!(member.mint, *mint_info.key, OnephoneError::InvalidSgt);
    }
    {
        let data = token_info.try_borrow_data()?;
        let token = StateWithExtensions::<Token2022Account>::unpack(&data)
            .map_err(|_| OnephoneError::InvalidSgt)?;
        require_keys_eq!(token.base.owner, *holder, OnephoneError::InvalidSgt);
        require_keys_eq!(token.base.mint, *mint_info.key, OnephoneError::InvalidSgt);
        require!(token.base.amount == 1, OnephoneError::InvalidSgt);
        require!(token.base.state != AccountState::Uninitialized, OnephoneError::InvalidSgt);
        // Frozen is the expected state for real SGT holder accounts.
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(id: [u8; 32])]
pub struct InitCampaign<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = Campaign::SPACE,
        seeds = [b"campaign", authority.key().as_ref(), id.as_ref()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,
    pub reward_mint: Account<'info, Mint>,
    #[account(mut, token::mint = reward_mint, token::authority = authority)]
    pub source: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        token::mint = reward_mint,
        token::authority = campaign,
        seeds = [b"vault", campaign.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(
        mut,
        seeds = [b"campaign", campaign.authority.as_ref(), campaign.id.as_ref()],
        bump = campaign.bump,
        has_one = reward_mint,
        has_one = vault
    )]
    pub campaign: Account<'info, Campaign>,
    #[account(
        init,
        payer = holder,
        space = Receipt::SPACE,
        seeds = [b"receipt", campaign.key().as_ref(), sgt_mint.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    /// CHECK: owner and typed Token-2022 mint/extensions verified in verify_sgt.
    pub sgt_mint: UncheckedAccount<'info>,
    /// CHECK: owner and typed Token-2022 account fields verified in verify_sgt.
    pub sgt_token: UncheckedAccount<'info>,
    pub reward_mint: Account<'info, Mint>,
    #[account(mut, token::mint = reward_mint, token::authority = campaign)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = reward_mint, token::authority = holder)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseCampaign<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"campaign", campaign.authority.as_ref(), campaign.id.as_ref()],
        bump = campaign.bump,
        has_one = authority,
        has_one = reward_mint,
        has_one = vault
    )]
    pub campaign: Account<'info, Campaign>,
    pub reward_mint: Account<'info, Mint>,
    #[account(mut, token::mint = reward_mint, token::authority = campaign)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = reward_mint, token::authority = authority)]
    pub refund: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Campaign {
    pub authority: Pubkey,
    pub id: [u8; 32],
    pub reward_mint: Pubkey,
    pub reward_amount: u64,
    pub max_claims: u32,
    pub claims: u32,
    pub deadline: i64,
    pub vault: Pubkey,
    pub closed: bool,
    pub bump: u8,
}

impl Campaign {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 4 + 4 + 8 + 32 + 1 + 1;
}

#[account]
pub struct Receipt {
    pub campaign: Pubkey,
    pub sgt_mint: Pubkey,
    pub holder: Pubkey,
}

impl Receipt {
    pub const SPACE: usize = 8 + 32 + 32 + 32;
}

#[error_code]
pub enum OnephoneError {
    #[msg("Invalid campaign terms")]
    InvalidTerms,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Invalid SGT mint or holder account")]
    InvalidSgt,
    #[msg("Campaign is closed")]
    CampaignClosed,
    #[msg("Campaign deadline has passed")]
    Expired,
    #[msg("Campaign claim limit reached")]
    ClaimLimit,
    #[msg("Campaign has not reached its deadline")]
    TooEarly,
}
